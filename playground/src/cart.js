'use strict';

// A deliberately small, slightly buggy module for the agent to play with.
function total(items) {
  let sum = 0;
  for (const item of items) {
    sum += item.price;
  }
  return sum;
}

function withTax(amount) {
  return amount * 1.18;
}

module.exports = { total, withTax };
