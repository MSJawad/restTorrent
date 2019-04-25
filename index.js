const fs = require('fs');
const bencode = require('bencode');

//to create a udp socket
const dgram = require('dgram');

//parsing the decoded bencode into hostname, port, etc
const urlParse = require ('url').parse;

// sending through a socket requires a buffer
const buffer = require('buffer').Buffer;

// decode the bencode serializationed string into someting legitble, get the
// trackers
const torrent = bencode.decode(fs.readFileSync('puppy.torrent'));

const url = urlParse(torrent.announce.toString('utf8'));

const socket = dgram.createSocket('udp4');

const newMsg = buffer.from('hello', 'utf8');

socket.send(newMsg, 0, newMsg.length, url.port, url.host, () => {});

// create a socket on turn on
socket.on('message', msg => {
    console.log('my message is', msg);
});



