const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const pgp = require('pg-promise')();
const fetch = require('node-fetch');

// Config
const proxyURL = 'http://proxy.gauntlet.moe';
const imageURL = 'http://image-mirror.gauntlet.moe';

// Set up the app
const app = express();
app.use(bodyParser.json({ type: 'application/json' }));

// Set up CORS library
app.use(cors());

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

  if (split.length < 2) return null;

  return {
    board: split[1],
    thread: split[3],
  };
}

function formatPosts(threadID, imageIDs, posts) {
  return posts.map((post, i) => ({
    thread: threadID,
    image: imageIDs[i],
    chan_id: post.no,
    body: post.com,
    author: post.name,
  }));
}

// Inserts a new thread into the DB
function createThread(details, posts, imageCoverID) {
  return db.query(`
    INSERT INTO threads (
      chan_id, 
      board,
      title,
      timestamp,
      cover
    ) 
    VALUES (
      ${parseInt(details.thread)},
      '${details.board}',
      '${posts[0] ? posts[0].sub : "Untitled"}',
      to_timestamp(${posts[0] ? posts[0].time : null}),
      ${imageCoverID}
    )
    RETURNING id
  `).then(data => data[0].id);
}

// Inserts a set of posts (from a thread) into the DB
function createPosts(threadID, imageIDs, posts) {
  // Convert the post object into a set of values (string) to be inserted
  const postValues = formatPosts(threadID, imageIDs, posts).map((post) => {
    const values = Object.keys(post).map(postKey => {
      // If it's a string, we'll need to wrap it in quotes for the DB Query
      if (typeof post[postKey] === 'string') return `'${post[postKey]}'`;

      // We need to explicitly return a NULL string or .join() will remove it
      if (post[postKey] === undefined) return 'NULL';

      return post[postKey];
    });
    return `(${values.join(', ')})`;
  }).join(', ');

  return db.query(`
    INSERT INTO posts (
      thread,
      img,
      chan_id, 
      body,
      author
    ) 
    VALUES ${postValues}
    RETURNING id
  `).then(data => data[0].id);
}

function createImages(details, posts) {
  // Image proxy promises
  const imageRequests = posts
    .map(post => (
      fetch(imageURL, {
        method: 'POST',
        headers: new fetch.Headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          url: `http://i.4cdn.org/${details.board}/${post.tim}${post.ext}`,
          folder: details.thread,
        }),
      })
        .then(resp => resp.json())
    ));

  // Update thread JSON
  return Promise.all(imageRequests).then((imageResponses) => {
    const imageValues = imageResponses.map((imgResp, i) => {
      return `('${imgResp.url}', ${posts[i].w}, ${posts[i].h})`;
    }).join(', ');

    return db.query(`
        INSERT INTO images (
          original,
          width,
          height
        ) 
        VALUES ${imageValues}
        RETURNING id
      `).then(resp => resp.map(img => img.id));
  });
}

// Set up the thread router
const threadRouter = express.Router();

// Get all threads
function getThreads(req, resp) {
  db.query(`
    SELECT id, board, timestamp, chan_id, title,
    (SELECT original AS cover FROM images WHERE threads.cover = id),
    (SELECT COUNT(id) AS post_count FROM posts WHERE posts.thread = threads.id)
    FROM threads
  `).then(data => {
    // Restructure from an Array into an Object with chan_id as the key
    const byID = Object.assign({}, ...data.map(thread => ({ [thread.chan_id]: thread })));
    resp.status(200).json(byID);
  });
}

// Get thread by ID
function getSingleThread(req, resp) {
  db.query(`
    SELECT json_build_object(
      'thread_id', t.id,
      'board', t.board,
      'timestamp', t.timestamp,
      'chan_id', t.chan_id,
      'title', t.title,
      'cover', (SELECT original FROM images WHERE t.cover = images.id),
      'post_count', (SELECT COUNT(id) FROM posts WHERE posts.thread = t.id),
      'posts', (SELECT json_agg(json_build_object(
          'post_id', p.id, 
          'body', p.body,
          'img', (SELECT original FROM images WHERE id = p.img),
          'width', (SELECT width FROM images WHERE id = p.img),
          'height', (SELECT height FROM images WHERE id = p.img)
        ))
        FROM posts p WHERE p.thread = t.id)) json
    FROM threads t WHERE t.chan_id = ${req.params.chanID}
  `).then(data => {
    // Did we find the thread?
    if (data.length) {
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

function imageValues(imageResponses) {
  return imageResponses.map((imgResp) => {
    return `('${imgResp.url}')`;
  }).join(', ');
}

function getProxiedThread(details) {
  return fetch(`${proxyURL}/http://a.4cdn.org/${details.board}/thread/${details.thread}.json`, {
    method: 'GET',
    headers: new fetch.Headers({
      'X-Requested-With': 'api',
      'Content-Type': 'application/json',
    }),
  }).then(proxyResp => proxyResp.json());
}

// Create a new thread from a 4chan URL
function handleCreateThread(req, resp) {
  // Were we passed a URL?
  if (!req.body.url) {
    return resp.status(400).json({
      status: 400,
      message: 'No thread URL provided.',
    })
  }

  // Extract board/thread details from URL
  const details = getThreadDetails(req.body.url);

  // Exit if we couldn't extract any details
  if (!details) {
    return resp.status(400).json({
      status: 400,
      message: 'Is it a valid URL?',
    });
  }

  // Get the proxied response
  getProxiedThread(details).then((proxyResp) => {
    // Filter out posts without images
    const filteredPosts = proxyResp.posts.filter(p => p.filename);

    // TODO: This is pretty ugly
    createImages(details, filteredPosts)
      .then((imageIDs) => {
        createThread(details, filteredPosts, imageIDs[0])
          .then((threadID) => {
             createPosts(threadID, imageIDs, filteredPosts)
               .then(() => {
                 resp.status(200).json({
                   message: `Thread ${details.thread} added successfully`,
                   thread_id: threadID,
                   chan_id: details.thread,
                 });
               });
          });
      });

  }).catch(error => {
    return resp.status(500).json({
      error,
      url: `${proxyURL}/http://a.4cdn.org/${details.board}/thread/${details.thread}.json`,
    });
  });
}

// Set up thread routes
threadRouter.get('/', getThreads);
threadRouter.post('/', handleCreateThread);
threadRouter.get('/:chanID', getSingleThread);

// Add the thread router to the application
app.use('/thread', threadRouter);

module.exports = app;