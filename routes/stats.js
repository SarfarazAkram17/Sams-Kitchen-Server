const express = require("express");
const router = express.Router();
const verifyJwt = require("../middleware/verifyJwt");
const verifyAdmin = require("../middleware/verifyAdmin");
const verifyCustomer = require("../middleware/verifyCustomer");

module.exports = (usersCollection, ordersCollection, ridersCollection, foodsCollection) => {
  router.get("/customer", verifyJwt, verifyCustomer, async (req, res) => {
    try {
      const { email } = req.query;
      const query = { "customer.email": email };

      const totalOrders = await ordersCollection.countDocuments(query);
      const completedOrders = await ordersCollection.countDocuments({ ...query, status: "delivered" });
      const processingOrders = await ordersCollection.countDocuments({ ...query, status: "not_assigned" });
      const dispatchedOrders = await ordersCollection.countDocuments({ ...query, status: "picked" });

      const totalSpent = await ordersCollection
        .aggregate([{ $match: { ...query, payment_status: "paid" } }, { $group: { _id: null, totalSpent: { $sum: "$total" } } }])
        .toArray();

      const totalSpentAmount = totalSpent.length > 0 ? totalSpent[0].totalSpent : 0;

      res.status(200).send({
        totalOrders,
        totalSpent: totalSpentAmount,
        processingOrders,
        dispatchedOrders,
        completedOrders,
      });
    } catch (error) {
      res.status(500).send({ message: error.message });
    }
  });

  router.get("/admin", verifyJwt, verifyAdmin, async (req, res) => {
    try {
      const totalUsers = await usersCollection.countDocuments();
      const totalRiders = await ridersCollection.countDocuments();
      const totalFoods = await foodsCollection.countDocuments();
      const totalOrders = await ordersCollection.countDocuments();

      const totalPayments = await ordersCollection
        .aggregate([{ $match: { payment_status: "paid" } }, { $group: { _id: null, totalPayments: { $sum: "$total" } } }])
        .toArray();

      const totalPaymentsAmount = totalPayments.length > 0 ? totalPayments[0].totalPayments : 0;

      const processingOrders = await ordersCollection.countDocuments({ status: "not_assigned" });
      const completedOrders = await ordersCollection.countDocuments({ status: "delivered" });
      const dispatchedOrders = await ordersCollection.countDocuments({ status: "picked" });

      res.status(200).send({
        totalUsers,
        totalRiders,
        totalFoods,
        totalOrders,
        totalPayments: totalPaymentsAmount,
        processingOrders,
        completedOrders,
        dispatchedOrders,
      });
    } catch (error) {
      res.status(500).send({ message: error.message });
    }
  });

  router.get("/rider", async (req, res) => {
    try {
      const { email } = req.query;
      const query = { assigned_rider_email: email };

      const totalOrders = await ordersCollection.countDocuments(query);
      const completedOrders = await ordersCollection.countDocuments({ ...query, status: "delivered" });
      const pickedOrders = await ordersCollection.countDocuments({ ...query, status: "picked" });
      const pendingOrders = await ordersCollection.countDocuments({ ...query, status: "assigned" });

      const totalEarningsData = await ordersCollection
        .aggregate([
          { $match: { ...query, status: "delivered" } },
          { $project: { deliveryCharge: 1, items: 1 } },
          {
            $group: {
              _id: null,
              totalEarnings: {
                $sum: {
                  $cond: [
                    { $eq: ["$deliveryCharge", 0] },
                    { $sum: [{ $cond: [{ $gt: [{ $size: "$items" }, 1] }, 50, 30] }] },
                    "$deliveryCharge",
                  ],
                },
              },
            },
          },
        ])
        .toArray();

      const totalEarningsAmount = totalEarningsData.length > 0 ? totalEarningsData[0].totalEarnings : 0;

      const cashoutMoneyData = await ordersCollection
        .aggregate([
          { $match: { ...query, cashout_status: "cashed_out" } },
          { $project: { deliveryCharge: 1, items: 1 } },
          {
            $group: {
              _id: null,
              cashoutMoney: {
                $sum: {
                  $cond: [
                    { $eq: ["$deliveryCharge", 0] },
                    { $sum: [{ $cond: [{ $gt: [{ $size: "$items" }, 1] }, 50, 30] }] },
                    "$deliveryCharge",
                  ],
                },
              },
            },
          },
        ])
        .toArray();

      const cashoutMoneyAmount = cashoutMoneyData.length > 0 ? cashoutMoneyData[0].cashoutMoney : 0;

      const pendingCashoutData = await ordersCollection
        .aggregate([
          { $match: { ...query, cashout_status: { $ne: "cashed_out" } } },
          { $project: { deliveryCharge: 1, items: 1 } },
          {
            $group: {
              _id: null,
              pendingCashout: {
                $sum: {
                  $cond: [
                    { $eq: ["$deliveryCharge", 0] },
                    { $sum: [{ $cond: [{ $gt: [{ $size: "$items" }, 1] }, 50, 30] }] },
                    "$deliveryCharge",
                  ],
                },
              },
            },
          },
        ])
        .toArray();

      const pendingCashoutAmount = pendingCashoutData.length > 0 ? pendingCashoutData[0].pendingCashout : 0;

      res.status(200).send({
        totalOrders,
        totalEarnings: totalEarningsAmount,
        pickedOrders,
        pendingOrders,
        completedOrders,
        cashoutMoney: cashoutMoneyAmount,
        pendingCashout: pendingCashoutAmount,
      });
    } catch (error) {
      res.status(500).send({ message: error.message });
    }
  });

  return router;
};