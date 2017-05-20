const express = require('express');
const bodyParser = require('body-parser');
const pgp = require('pg-promise')();
const axios = require('axios');

// Config
const proxyURL = 'http://proxy.gauntlet.moe';
const imageURL = 'http://image-mirror.gauntlet.moe';

// Set up the app
const app = express();
app.use(bodyParser.json({ type: 'application/json' }));

// Set up the DB
const db = pgp({
  host: 'localhost',
  port: 5432,
  database: 'gauntlet',
  user: 'jfree',
  password: '',
});

// Split the URL to get the board/ID
function getThreadDetails(url) {
  const split = url.replace('http://', '').split('/');

  if (url.length < 2) return null;

  return {
    board: split[1],
    thread: split[3],
  };
}

function formatPosts(threadID, posts) {
  return posts.map(post => ({
    chan_id: post.no,
    thread: threadID,
    body: post.com,
    img: post.tim ? `${post.tim}${post.ext}` : undefined,
    author: post.name,
  }));
}

// Inserts a new thread into the DB
function createThread(details, posts) {
  return db.query(`
    INSERT INTO threads (
      chan_id, 
      board,
      title,
      timestamp,
      img_root
    ) 
    VALUES (
      ${parseInt(details.thread)},
      '${details.board}',
      '${posts[0] ? posts[0].sub : null}',
      to_timestamp(${posts[0] ? posts[0].time : null}),
      'http://i.4cdn.org/${details.board}/'
    )
    RETURNING id
  `).then(data => data[0].id);

  // '${JSON.stringify(formatPosts(details, posts))}',
}

// Inserts a set of posts (from a thread) into the DB
function createPosts(threadID, posts) {
  // Convert the post object into a set of values (string) to be inserted
  const postValues = formatPosts(threadID, posts).map((post) => {
    const values = Object.keys(post).map(postKey => {
      // If it's a string, we'll need to wrap it in quotes for the DB Query
      if (typeof post[postKey] === 'string') return `'${post[postKey]}'`;

      // We need to explicitly return a NULL string or .join() will remove it
      if (post[postKey] === undefined) return 'NULL';

      return post[postKey];
    });
    return `(${values.join(', ')})`;
  }).join(', ');

  // console.log(postValues);

  return db.query(`
    INSERT INTO posts (
      chan_id, 
      thread,
      body,
      img,
      author
    ) 
    VALUES ${postValues}
    RETURNING id
  `).then(data => data[0].id);
}

// Set up the thread router
const threadRouter = express.Router();

// Get all threads
function getThreads(req, resp) {
  db.query('SELECT * FROM threads').then(data => {
    resp.status(200).json(data);
  });
}

// Get thread by ID
function getSingleThread(req, resp) {
  db.query(`
    SELECT json_build_object('thread_id', t.id, 'posts',
        (SELECT json_agg(json_build_object(
          'post_id', p.id, 
          'body', p.body,
          'img', p.img
        ))
        FROM posts p WHERE p.thread = t.id AND p.img IS NOT NULL)) json
    FROM threads t
  `).then(data => {
    // Did we find the thread?
    if (data.length) {
      // TODO: Should be able to just return the JSON object ('data')
      // This is a hacky way of clearing out the wrappers
      resp.status(200).json(data[0].json);
    } else {
      resp.status(404).json({
        status: 404,
        message: 'Thread not found',
      });
    }
  });
}

// Create a new thread from a 4chan URL
function handleCreateThread(req, resp) {
  // Were we passed a URL?
  if (!req.body.url) {
    resp.status(400).json({
      status: 400,
      message: 'No thread URL provided.',
    })
  }

  const details = getThreadDetails(req.body.url);

  // Get the proxied response
  axios.get(`${proxyURL}/http://a.4cdn.org/${details.board}/thread/${details.thread}.json`, {
    headers: {
      'X-Requested-With': true,
      'Content-Type': 'application/json',
    }
  }).then(proxyResp => {
    if (!proxyResp.data.posts) return;

    // Create a new thread
    createThread(details, proxyResp.data.posts)
      .then((id) => {
        // Thread is created, return a response
        resp.status(200).json({
          message: `Thread ${details.thread} added successfully`,
          data: proxyResp.data,
        });

        // Create the posts
        createPosts(id, proxyResp.data.posts);

        // Image proxy promises
        const imageRequests = proxyResp.data.posts
          .filter(post => post.tim && post.ext)
          .map(post => (
            axios.post(imageURL, {
              url: `http://i.4cdn.org/${details.board}/${post.tim}${post.ext}`,
              folder: id,
            })
            .then(resp => resp.data)
          ));

        // Update thread JSON
        axios.all(imageRequests).then((imageResponses) => {
          // Presume the bucket is consistent, just grab it from the first image
          const newRoot = imageResponses[0]['img_root'];

          db.query(`
            UPDATE threads
            SET img_root = '${newRoot}'
            WHERE id = ${id}
           `);
        });

      }).catch(error => resp.status(500).json({ error }));

  }).catch(error => resp.status(500).json({ error, url: `${proxyURL}/http://a.4cdn.org/${details.board}/thread/${details.thread}.json`, }));
}

// Set up thread routes
threadRouter.get('/', getThreads);
threadRouter.post('/', handleCreateThread);
threadRouter.get('/:id', getSingleThread);

// Add the thread router to the application
app.use('/thread', threadRouter);

module.exports = app;