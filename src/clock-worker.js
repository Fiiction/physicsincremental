let interval = 1000 / 60, timer, sentAt;
function pulse() { sentAt = performance.now(); postMessage('frame'); }
self.onmessage = ({ data }) => {
  clearTimeout(timer);
  if (typeof data === 'number') { interval = Math.max(8, data); pulse(); }
  else if (data === 'ack') timer = setTimeout(pulse, Math.max(0, interval - (performance.now() - sentAt)));
};
