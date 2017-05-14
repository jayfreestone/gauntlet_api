const express = require('express');
const bodyParser = require('body-parser');
const pgp = require('pg-promise')();
const axios = require('axios');

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
function createThread(req, resp) {
  // Were we passed a URL?
  if (!req.body.url) {
    resp.status(400).json({
      status: 400,
      message: 'No thread URL provided.',
    })
  }

  // Split the URL to get the board/ID
  const split = req.body.url.replace('http://', '').split('/');
  const board = split[1];
  const thread = split[3];

  // Get the proxied response
  axios.get(`http://proxy.gauntlet.moe/http://a.4cdn.org/${board}/thread/${thread}.json`, {
    headers: {
      'X-Requested-With': true,
      'Content-Type': 'application/json',
    }
  }).then(proxyResp => {
    if (proxyResp.data.posts) {
      // console.log();
      db.query(`
        INSERT INTO threads (
          chan_id, 
          board,
          timestamp,
          posts
        ) 
        VALUES (
          ${parseInt(thread)},
          '${board}',
          to_timestamp(${proxyResp.data.posts[0].time}),
          '${JSON.stringify(proxyResp.data.posts)}'
        )
      `).then(() => {
        resp.status(200).json({
          message: `Thread ${thread} added successfully`,
          data: proxyResp.data,
        });
      }).catch(error => resp.status(500).json({ error }));
    }
  }).catch(error => resp.status(500).json({ error, url: `http://proxy.gauntlet.moe/${req.body.url}`, }));
}

// Set up thread routes
threadRouter.get('/', getThreads);
threadRouter.post('/', createThread);
threadRouter.get('/:id', getSingleThread);

// Add the thread router to the application
app.use('/thread', threadRouter);

module.exports = app;