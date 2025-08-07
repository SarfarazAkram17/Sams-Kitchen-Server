const express = require("express");
const router = express.Router();
const verifyJwt = require("../middleware/verifyJwt");

module.exports = (notificationsCollection) => {
  router.get("/", async (req, res) => {
    try {
      const { email, page = 1, limit = 7 } = req.query;
      if (!email) {
        return res.status(400).json({ message: "Email is required" });
      }

      const pageNum = parseInt(page);
      const pageLimit = parseInt(limit);

      // Direct notifications
      const direct = await notificationsCollection
        .find({ type: "direct", email })
        .toArray();

      // Broadcast notifications (check if user already read)
      const broadcast = await notificationsCollection
        .find({ type: "broadcast" })
        .toArray();

      const allNotifications = [...direct, ...broadcast].map((n) => {
        if (n.type === "broadcast") {
          return {
            ...n,
            isRead: n.readBy?.includes(email) || false,
          };
        }
        return n;
      });

      // Sort newest first
      const sorted = allNotifications.sort(
        (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
      );

      // Pagination
      const start = (pageNum - 1) * pageLimit;
      const paginated = sorted.slice(start, start + pageLimit);

      res.send({
        notifications: paginated,
        total: sorted.length,
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  router.patch("/readAll", verifyJwt, async (req, res) => {
    try {
      const { email } = req.query;

      if (!email) {
        return res.status(400).json({ message: "Email is required" });
      }

      // Direct notifications
      const direct = await notificationsCollection.updateMany(
        { type: "direct", email, isRead: false },
        { $set: { isRead: true } }
      );

      // Broadcast notifications → add email to readBy
      const broadcast = await notificationsCollection.updateMany(
        { type: "broadcast", readBy: { $ne: email } },
        { $addToSet: { readBy: email } }
      );

      res.send({
        directUpdated: direct.modifiedCount,
        broadcastUpdated: broadcast.modifiedCount,
      });
    } catch (err) {
      res.status(500).json({ message: "Failed to mark all as read" });
    }
  });

  return router;
};