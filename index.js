const fs = require('fs');
const bencode = require('bencode');
const tracker = require('./tracker.js');

//to create a udp socket

// decode the bencode serializationed string into someting legitble, get the
// trackers
const torrent = bencode.decode(fs.readFileSync('puppy.torrent'));

tracker.getPeers(torrent, (peers) => {
    console.log('list of peers: ', peers);
});
