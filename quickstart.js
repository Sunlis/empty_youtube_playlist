var fs = require('fs');
var readline = require('readline');
var {google} = require('googleapis');
var OAuth2 = google.auth.OAuth2;

// If modifying these scopes, delete your previously saved credentials
// at ~/.credentials/youtube-nodejs-quickstart.json
var SCOPES = ['https://www.googleapis.com/auth/youtube'];
var TOKEN_DIR = (process.env.HOME || process.env.HOMEPATH ||
    process.env.USERPROFILE) + '/.credentials/';
var TOKEN_PATH = TOKEN_DIR + 'youtube-nodejs-quickstart.json';

// Load client secrets from a local file.
fs.readFile('client_secret.json', function processClientSecrets(err, content) {
  if (err) {
    console.log('Error loading client secret file: ' + err);
    return;
  }
  // Authorize a client with the loaded credentials, then call the YouTube API.
  authorize(JSON.parse(content), doApiStuff);
});

/**
 * Create an OAuth2 client with the given credentials, and then execute the
 * given callback function.
 *
 * @param {Object} credentials The authorization client credentials.
 * @param {function} callback The callback to call with the authorized client.
 */
function authorize(credentials, callback) {
  var clientSecret = credentials.installed.client_secret;
  var clientId = credentials.installed.client_id;
  var redirectUrl = credentials.installed.redirect_uris[0];
  var oauth2Client = new OAuth2(clientId, clientSecret, redirectUrl);

  // Check if we have previously stored a token.
  fs.readFile(TOKEN_PATH, function(err, token) {
    if (err) {
      getNewToken(oauth2Client, callback);
    } else {
      oauth2Client.credentials = JSON.parse(token);
      callback(oauth2Client);
    }
  });
}

/**
 * Get and store new token after prompting for user authorization, and then
 * execute the given callback with the authorized OAuth2 client.
 *
 * @param {google.auth.OAuth2} oauth2Client The OAuth2 client to get token for.
 * @param {getEventsCallback} callback The callback to call with the authorized
 *     client.
 */
function getNewToken(oauth2Client, callback) {
  var authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES
  });
  console.log('Authorize this app by visiting this url: ', authUrl);
  var rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  rl.question('Enter the code from that page here: ', function(code) {
    rl.close();
    oauth2Client.getToken(code, function(err, token) {
      if (err) {
        console.log('Error while trying to retrieve access token', err);
        return;
      }
      oauth2Client.credentials = token;
      storeToken(token);
      callback(oauth2Client);
    });
  });
}

/**
 * Store token to disk be used in later program executions.
 *
 * @param {Object} token The token to store to disk.
 */
function storeToken(token) {
  try {
    fs.mkdirSync(TOKEN_DIR);
  } catch (err) {
    if (err.code != 'EEXIST') {
      throw err;
    }
  }
  fs.writeFile(TOKEN_PATH, JSON.stringify(token), (err) => {
    if (err) throw err;
    console.log('Token stored to ' + TOKEN_PATH);
  });
}


// Default API quota is 10k queries per day. Note that not every query has
// equal cost. List calls are typically 1, but delete calls are 50.
// https://developers.google.com/youtube/v3/determine_quota_cost
// In our case playlistItems.list costs 1, but playlistItems.delete costs 50.
const queriesPerDay = 100000;
// Delay needed between each query to stay below quota.
// Must be multiplied by query cost.
const queryDelay = Math.ceil((24 * 60 * 60 * 1000) / queriesPerDay);

// Playlist with 684 items in it represents a quota cost of 684*50 = 34200
// to delete each item. Plus an additional 14 list requests, we get a total
// query cost of 34214. If we schedule our API calls perfectly, we can complete
// this task in 3.4214 days. Neat.
//
// A friend of mine (who inspired this) has a Watch Later playlist with
// over 1700 videos in it. Many of them are watched, but our systems do not
// recognize them as such. Likely due to the known watch history horizon
// limitations.
// The math on their WL is fun.
// 1700 items = 1700*50 = 85000 cost for delete queries
// 1700/50 = 24 cost for list queries
// total query cost = 85024
// Best possible time to completion: 8.5024 days
// More realistically, adding a small buffer to attempt to thwart and quota
// issues, at least 9 days.

const tasks = [];
const scheduleApiTask = (auth, task, cost) => {
  tasks.push({
    auth,
    task,
    cost,
  });
};

const deletePlaylistItem = (auth, id) => {
  return new Promise((resolve, reject) => {
    const service = google.youtube('v3');
    service.playlistItems.delete({
      auth,
      id,
    }, (err, resp) => {
      if (err) reject(err);
      else resolve(resp);
    });
  });
};

const getPlaylistItemPage = (auth, playlistId, pageToken) => {
  return new Promise((resolve, reject) => {
    const service = google.youtube('v3');
      service.playlistItems.list({
        auth,
        playlistId: 'PLnXgCmvo9lP2Y1DtUSWuAeNdDYcpGBcyf',
        part: 'id',
        maxResults: 50,
        pageToken: pageToken || undefined,
      }, (err, resp) => {
        if (err) reject(err);
        else resolve(resp);
      });
    });
};

const processPage = (auth, playlistId, pageToken) => {
  scheduleApiTask(auth, (auth) => {
    return getPlaylistItemPage(auth, playlistId, pageToken).then((resp) => {
      const items = resp.data.items;
      items.forEach((item) => {
        scheduleApiTask(auth, (auth) => {
          return deletePlaylistItem(auth, item.id);
        }, 50);
      });
      if (resp.data.nextPageToken) {
        processPage(auth, playlistId, resp.data.nextPageToken);
      }
    });
  }, 1);
};

let processed = 0;
const runApiTasks = async () => {
  const task = tasks[0];
  console.log(`running task ${processed} with cost ${task.cost}`);
  await task.task(task.auth);
  processed++;
  tasks.splice(0, 1);
  if (tasks.length > 0) {
    console.log(`waiting ${queryDelay * task.cost}ms before next operation`);
    console.log(`${tasks.length} tasks remain`)
    setTimeout(runApiTasks, queryDelay * task.cost);
  } else {
    console.log(`task queue is empty. ran ${processed} total tasks.`);
  }
};

const PLAYLIST_ID = 'PLnXgCmvo9lP2Y1DtUSWuAeNdDYcpGBcyf';

function doApiStuff(auth) {
  console.log(`Configured daily quota is ${queriesPerDay}. Delay between queries is ${queryDelay}ms * cost.`);
  processPage(auth, PLAYLIST_ID);
  runApiTasks();
}
