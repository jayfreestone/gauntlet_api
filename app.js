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

// Utility

// Split the URL to get the board/ID
function getThreadDetails(url) {
  const split = url.replace('http://', '').split('/');

  if (url.length < 2) return null;

  return {
    board: split[1],
    thread: split[3],
  };
}

function formatPosts(details, posts) {
  return posts.map(post => ({
    id: post.no,
    name: post.name,
    body: post.com,
    img: `${post.tim}${post.ext}`,
    // img: `http://i.4cdn.org/${details.board}/${post.tim}${post.ext}`,
  }));
}

function createThread(details, posts) {
  return db.query(`
    INSERT INTO threads (
      chan_id, 
      board,
      title,
      timestamp,
      posts,
      img_root
    ) 
    VALUES (
      ${parseInt(details.thread)},
      '${details.board}',
      '${posts[0] ? posts[0].sub : null}',
      to_timestamp(${posts[0] ? posts[0].time : null}),
      '${JSON.stringify(formatPosts(details, posts))}',
      'http://i.4cdn.org/${details.board}/'
    )
    RETURNING id
  `).then(data => data[0].id);
}

function mirrorImages() {

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
  db.query(`SELECT * FROM threads WHERE id = ${req.params.id}`).then(data => {
    // Did we find the thread?
    if (data.length) {
      resp.status(200).json(data);
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
        console.log(`The thread id is: ${id}`);
        // Thread is created, return a response
        resp.status(200).json({
          message: `Thread ${details.thread} added successfully`,
          data: proxyResp.data,
        });

        // Image proxy promises
        const imageRequests = proxyResp.data.posts
          .filter(post => post.tim && post.ext)
          .map(post => (
            axios.get(`${imageURL}/http://i.4cdn.org/${details.board}/${post.tim}${post.ext}`)
              .then(resp => resp.data)
          ));

        // Update thread JSON
        axios.all(imageRequests).then(() => {
          db.query(`
            UPDATE threads
            SET img_root = 'https://s3-us-west-1.amazonaws.com/gauntlet-images/'
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