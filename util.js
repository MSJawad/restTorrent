const crypto = require('crypto');

let id = null;

function getId() {
  if (!id) {
    id = crypto.randomBytes(20);
    Buffer.from('-MJ0001-').copy(id, 0);
  }
  return id;
};

module.exports.getId = getId;
