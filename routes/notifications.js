import express from "express";
const router = express.Router();
import verifyJwt from "../middleware/verifyJwt.js";
import { attachNotificationStream } from "../services/notifications.js";

export default (notificationsCollection) => {
  router.get("/stream", verifyJwt, (req, res) => {
    attachNotificationStream(req.user.email, res);
  });

  router.get("/", verifyJwt, async (req, res) => {
    try {
      const email = req.user.email;
      const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
      const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 7));

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
      const start = (page - 1) * limit;
      const paginated = sorted.slice(start, start + limit);

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
      const email = req.user.email;

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