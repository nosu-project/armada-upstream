/// <reference lib="webworker" />

type Request = { op: "set"; id: number; ms: number; repeat: boolean } | { op: "clear"; id: number };

const timers = new Map<number, ReturnType<typeof setTimeout>>();

self.onmessage = (event: MessageEvent<Request>) => {
  const msg = event.data;
  if (msg.op === "clear") {
    const t = timers.get(msg.id);
    clearTimeout(t);
    clearInterval(t);
    timers.delete(msg.id);
    return;
  }
  const { id, ms, repeat } = msg;
  const fire = () => {
    if (!repeat) timers.delete(id);
    self.postMessage(id);
  };
  timers.set(id, repeat ? setInterval(fire, ms) : setTimeout(fire, ms));
};
