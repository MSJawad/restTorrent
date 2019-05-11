'use strict';

const fs = require('fs');
const bencode = require('bencode');
const tracker = require('./tracker.js');
const torrentParser = require('./torrent-parser.js');
//to create a udp socket

// decode the bencode serializationed string into someting legitble, get the
// trackers

const torrent = torrentParser.open('test.torrent');

tracker.getPeers(torrent, (peers) => {
    console.log('list of peers: ', peers);
});
