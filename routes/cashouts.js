import express from "express";
const router = express.Router();
import { ObjectId } from "mongodb";
import { ADMIN_EMAIL } from "../config/admin.js";
import verifyJwt from "../middleware/verifyJwt.js";
import verifyAdmin from "../middleware/verifyAdmin.js";
import verifyRider from "../middleware/verifyRider.js";
import { saveNotification } from "../services/notifications.js";

// Same earning rule used by the rider stats: the delivery charge, or the base
// rider rate (30 / 50) when the customer got free delivery.
const earningExpr = {
  $cond: [
    { $eq: ["$deliveryCharge", 0] },
    { $cond: [{ $gt: [{ $size: { $ifNull: ["$items", []] } }, 1] }, 50, 30] },
    { $ifNull: ["$deliveryCharge", 0] },
  ],
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const taka = (n) => `৳${round2(n).toLocaleString("en-BD")}`;

// Delivered orders that are not part of any cashout request yet.
const availableEarnings = (email) => ({
  assigned_rider_email: email,
  status: "delivered",
  cashout_status: { $nin: ["requested", "cashed_out"] },
});

// Allowed payout methods and the details each one needs.
const NAME = /^[\p{L} .'-]{2,60}$/u;
const TEXT = /^[\p{L}\p{N} .,&'()-]{2,80}$/u;
const ACCOUNT_TYPE = { label: "Account type", pattern: /^(personal|agent)$/ };
const wallet = (numberPattern) => ({
  accountNumber: { label: "Account number", pattern: numberPattern },
  accountType: ACCOUNT_TYPE,
});

const METHOD_FIELDS = {
  bkash: wallet(/^01[3-9]\d{8}$/),
  nagad: wallet(/^01[3-9]\d{8}$/),
  rocket: wallet(/^01[3-9]\d{8,9}$/),
  card: {
    cardHolderName: { label: "Card holder name", pattern: NAME },
    cardNumber: {
      label: "Card number",
      pattern: /^\d{13,19}$/,
      normalize: (value) => value.replace(/[\s-]/g, ""),
    },
    bankName: { label: "Issuing bank", pattern: TEXT },
  },
  bank: {
    accountHolder: { label: "Account holder name", pattern: NAME },
    bankName: { label: "Bank name", pattern: TEXT },
    branchName: { label: "Branch name", pattern: TEXT },
    accountNumber: { label: "Account number", pattern: /^\d{6,20}$/ },
  },
};

const parsePaging = (query, defaultLimit = 10) => ({
  page: Math.max(1, Number.parseInt(query.page, 10) || 1),
  limit: Math.min(50, Math.max(1, Number.parseInt(query.limit, 10) || defaultLimit)),
});

export default (cashoutsCollection, ordersCollection, notificationsCollection) => {
  const notify = (email, message, relatedId) =>
    saveNotification(notificationsCollection, {
      type: "direct",
      email,
      message,
      relatedId,
      createdAt: new Date().toISOString(),
      isRead: false,
    });

  // ------------------------------------------------------------------ rider
  router.get("/balance", verifyJwt, verifyRider, async (req, res) => {
    try {
      const rows = await ordersCollection
        .aggregate([
          { $match: { assigned_rider_email: req.user.email, status: "delivered" } },
          {
            $group: {
              _id: { $ifNull: ["$cashout_status", "available"] },
              amount: { $sum: earningExpr },
              orders: { $sum: 1 },
            },
          },
        ])
        .toArray();
      const bucket = (key) => rows.find((row) => row._id === key);

      res.send({
        available: round2(bucket("available")?.amount),
        availableOrders: bucket("available")?.orders || 0,
        requested: round2(bucket("requested")?.amount),
        cashedOut: round2(bucket("cashed_out")?.amount),
      });
    } catch (error) {
      res.status(500).send({ message: "Failed to load your balance" });
    }
  });

  router.get("/me", verifyJwt, verifyRider, async (req, res) => {
    try {
      const { page, limit } = parsePaging(req.query);
      const query = { riderEmail: req.user.email };
      const [requests, total] = await Promise.all([
        cashoutsCollection
          .find(query)
          .sort({ requestedAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .toArray(),
        cashoutsCollection.countDocuments(query),
      ]);
      res.send({ requests, total });
    } catch (error) {
      res.status(500).send({ message: "Failed to load your cashout requests" });
    }
  });

  router.post("/", verifyJwt, verifyRider, async (req, res) => {
    const { method, details } = req.body || {};
    const fields = METHOD_FIELDS[method];
    if (!fields) {
      return res.status(400).send({ message: "Choose a valid payout method" });
    }

    const cleanDetails = {};
    for (const [name, { label, pattern, normalize }] of Object.entries(fields)) {
      const raw = typeof details?.[name] === "string" ? details[name].trim() : "";
      const value = normalize ? normalize(raw) : raw;
      if (!pattern.test(value)) {
        return res.status(400).send({ message: `${label} is missing or invalid` });
      }
      cleanDetails[name] = value;
    }

    const requestId = new ObjectId();
    const claimId = requestId.toString();

    try {
      // Claim every available delivered order for this request so the same
      // earnings can never be requested twice.
      const claim = await ordersCollection.updateMany(availableEarnings(req.user.email), {
        $set: { cashout_status: "requested", cashoutRequestId: claimId },
      });
      if (!claim.modifiedCount) {
        return res.status(409).send({ message: "You have no earnings available to cash out" });
      }

      const [claimed] = await ordersCollection
        .aggregate([
          { $match: { cashoutRequestId: claimId } },
          {
            $group: {
              _id: null,
              amount: { $sum: earningExpr },
              orderIds: { $push: { $toString: "$_id" } },
              riderName: { $first: "$assigned_rider_name" },
            },
          },
        ])
        .toArray();

      const request = {
        _id: requestId,
        riderEmail: req.user.email,
        riderName: claimed.riderName,
        method,
        details: cleanDetails,
        amount: round2(claimed.amount),
        orderIds: claimed.orderIds,
        status: "pending",
        requestedAt: new Date().toISOString(),
      };

      try {
        await cashoutsCollection.insertOne(request);
      } catch (error) {
        await ordersCollection.updateMany(
          { cashoutRequestId: claimId },
          { $unset: { cashout_status: "", cashoutRequestId: "" } },
        );
        throw error;
      }

      await Promise.all([
        notify(req.user.email, `Your cashout request of ${taka(request.amount)} was submitted.`, claimId),
        notify(ADMIN_EMAIL, `${request.riderName} requested a cashout of ${taka(request.amount)}.`, claimId),
      ]);

      res.status(201).send(request);
    } catch (error) {
      res.status(500).send({ message: "Failed to submit the cashout request" });
    }
  });

  // ------------------------------------------------------------------ admin
  router.get("/", verifyJwt, verifyAdmin, async (req, res) => {
    try {
      const status = req.query.status === "cashed_out" ? "cashed_out" : "pending";
      const { page, limit } = parsePaging(req.query);
      const sort = status === "pending" ? { requestedAt: 1 } : { cashedOutAt: -1 };

      const [requests, pendingCount, cashedOutCount] = await Promise.all([
        cashoutsCollection
          .find({ status })
          .sort(sort)
          .skip((page - 1) * limit)
          .limit(limit)
          .toArray(),
        cashoutsCollection.countDocuments({ status: "pending" }),
        cashoutsCollection.countDocuments({ status: "cashed_out" }),
      ]);

      res.send({
        requests,
        total: status === "pending" ? pendingCount : cashedOutCount,
        counts: { pending: pendingCount, cashed_out: cashedOutCount },
      });
    } catch (error) {
      res.status(500).send({ message: "Failed to load cashout requests" });
    }
  });

  router.patch("/:id/cashed-out", verifyJwt, verifyAdmin, async (req, res) => {
    const { id } = req.params;
    const { proofUrl, transactionId = "", note = "" } = req.body || {};
    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid cashout request ID" });
    }

    let proof;
    try {
      proof = new URL(proofUrl);
    } catch {
      return res.status(400).send({ message: "A proof attachment is required" });
    }
    if (proof.protocol !== "https:" || proof.hostname !== "res.cloudinary.com") {
      return res.status(400).send({ message: "The proof attachment must be an uploaded image" });
    }

    try {
      const cashedOutAt = new Date().toISOString();
      const request = await cashoutsCollection.findOneAndUpdate(
        { _id: new ObjectId(id), status: "pending" },
        {
          $set: {
            status: "cashed_out",
            proofUrl: proof.href,
            transactionId: String(transactionId).trim().slice(0, 60),
            note: String(note).trim().slice(0, 300),
            cashedOutAt,
          },
        },
        { returnDocument: "after" },
      );
      if (!request) {
        return res.status(409).send({ message: "This request is not waiting for payment" });
      }

      await ordersCollection.updateMany(
        { cashoutRequestId: id },
        { $set: { cashout_status: "cashed_out", cashedOutAt } },
      );
      await notify(
        request.riderEmail,
        `Your cashout of ${taka(request.amount)} was sent. Open Cashouts to see the payment proof.`,
        id,
      );

      res.send(request);
    } catch (error) {
      res.status(500).send({ message: "Failed to update the cashout request" });
    }
  });

  return router;
};
