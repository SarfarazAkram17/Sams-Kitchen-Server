const connections = new Map();

function publishNotification(notification) {
  const payload = JSON.stringify(notification);
  const listenerGroups =
    notification.type === "broadcast"
      ? connections.values()
      : [connections.get(notification.email)].filter(Boolean);

  for (const listeners of listenerGroups) {
    for (const response of listeners) {
      if (!response.writableEnded) response.write(`data: ${payload}\n\n`);
    }
  }
}

async function saveNotification(collection, notification) {
  const result = await collection.insertOne(notification);
  publishNotification({
    ...notification,
    _id: result.insertedId,
  });
  return result;
}

function attachNotificationStream(email, response) {
  if (!connections.has(email)) connections.set(email, new Set());
  const listeners = connections.get(email);
  listeners.add(response);

  response.status(200);
  response.set({
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream",
    "X-Accel-Buffering": "no",
  });
  response.flushHeaders?.();
  response.write(": connected\n\n");

  const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 25000);
  response.on("close", () => {
    clearInterval(heartbeat);
    listeners.delete(response);
    if (listeners.size === 0) connections.delete(email);
  });
}

export { attachNotificationStream, saveNotification };
