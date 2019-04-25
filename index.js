const fs = require('fs');
const bencode = require('bencode');

const dgram = require('dgram');
const urlParse = require ('url').parse;
const buffer = require('buffer').Buffer;


// decode the bencode serializationed string into someting legitble, get the
// trackers
const torrent = bencode.decode(fs.readFileSync('puppy.torrent'));

const url = urlParse(torrent.announce.toString('utf8'));

const socket = dgram.createSocket('udp4');

const newMsg = buffer.from('hello', 'utf8');

socket.send(newMsg, 0, newMsg.length, url.port, url.host, () => {});

socket.on('message', msg => {
    console.log('my message is', msg);
});



