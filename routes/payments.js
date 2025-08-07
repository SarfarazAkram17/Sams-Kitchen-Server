const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");
const axios = require("axios");
const stripe = require("../config/stripe");
const verifyJwt = require("../middleware/verifyJwt");

module.exports = (
  ordersCollection,
  paymentsCollection,
  notificationsCollection
) => {
  router.post("/create-ssl-payment", verifyJwt, async (req, res) => {
    const store_id = process.env.STORE_ID;
    const store_passwd = process.env.STORE_PASSWORD;

    const payment = req.body;
    const order = await ordersCollection.findOne({
      _id: new ObjectId(payment.orderId),
    });

    const tran_id = new ObjectId().toString();
    payment.transactionId = tran_id;

    const initiate = {
      store_id,
      store_passwd,
      total_amount: order.total,
      currency: "BDT",
      tran_id,
      success_url: "https://sams-kitchen.vercel.app/payments/success-payment",
      fail_url: "https://sams-kitchen.vercel.app/payments/fail-payment",
      cancel_url: "https://sams-kitchen.vercel.app/payments/cancel-payment",
      ipn_url: "https://sams-kitchen.vercel.app/payments/ipn-success-payment",
      shipping_method: "Courier",
      product_name: "Foods",
      product_category: "Food",
      product_profile: "general",
      cus_name: payment.name,
      cus_email: payment.email,
      cus_add1: order.customer.address.district,
      cus_city: order.customer.address.thana,
      cus_state: order.customer.address.region,
      cus_country: "Bangladesh",
      cus_phone: order.customer.phone,
      ship_name: payment.name,
      ship_add1: order.customer.address.district,
      ship_city: order.customer.address.thana,
      ship_state: order.customer.address.region,
      ship_postcode: 1000,
      ship_country: "Bangladesh",
    };

    const iniRes = await axios({
      url: "https://sandbox.sslcommerz.com/gwprocess/v4/api.php",
      method: "POST",
      data: initiate,
      headers: { "Content-type": "application/x-www-form-urlencoded" },
    });

    const gatewayUrl = iniRes?.data?.GatewayPageURL;

    await paymentsCollection.insertOne(payment);

    res.status(201).send({ gatewayUrl });
  });

  router.post("/success-payment", async (req, res) => {
    const paymentSuccess = req.body;
    const query = { transactionId: paymentSuccess.tran_id };
    const payment = await paymentsCollection.findOne(query);

    const store_id = process.env.STORE_ID;
    const store_passwd = process.env.STORE_PASSWORD;

    const isValidPayment = await axios.get(
      `https://sandbox.sslcommerz.com/validator/api/validationserverAPI.php?val_id=${paymentSuccess.val_id}&store_id=${store_id}&store_passwd=${store_passwd}`
    );

    if (isValidPayment?.data?.status === "VALID") {
      const updatedOrder = {
        $set: {
          payment_status: "paid",
          status: "not_assigned",
          paidAt: new Date().toISOString(),
        },
      };
      await ordersCollection.updateOne(
        { _id: new ObjectId(payment.orderId) },
        updatedOrder
      );

      const updatedPayment = {
        $set: {
          status: "payment done",
          paidAt: new Date().toISOString(),
        },
      };
      await paymentsCollection.updateOne(query, updatedPayment);

      const notificationForUser = {
        type: "direct",
        email: payment.email,
        message: `Your payment is successfully done. Go to my orders and you can download your reciept.`,
        relatedId: payment.orderId.toString(),
        createdAt: new Date().toISOString(),
        isRead: false,
      };

      await notificationsCollection.insertOne(notificationForUser);

      const notificationForAdmin = {
        type: "direct",
        email: "sarfarazakram16@gmail.com",
        message: `Get payment successfully.`,
        relatedId: payment.orderId.toString(),
        createdAt: new Date().toISOString(),
        isRead: false,
      };

      await notificationsCollection.insertOne(notificationForAdmin);

      return res.redirect("https://sams-kitchen.netlify.app/dashboard/myOrders");
    } else {
      await paymentsCollection.deleteOne(query);
      res.redirect("https://sams-kitchen.netlify.app/dashboard/myOrders");
      return res.send({ message: "Invalid payment" });
    }
  });

  router.post("/fail-payment", async (req, res) => {
    const failPayment = req.body;
    const query = { transactionId: failPayment.tran_id };
    await paymentsCollection.deleteOne(query);
    return res.redirect("https://sams-kitchen.netlify.app/dashboard/myOrders");
  });

  router.post("/cancel-payment", async (req, res) => {
    const cancelPayment = req.body;
    const query = { transactionId: cancelPayment.tran_id };
    await paymentsCollection.deleteOne(query);
    return res.redirect("https://sams-kitchen.netlify.app/dashboard/myOrders");
  });

  router.post("/create-payment-intent", verifyJwt, async (req, res) => {
    try {
      const paymentIntent = await stripe.paymentIntents.create({
        amount: req.body.amountInCents,
        currency: "bdt",
        payment_method_types: ["card"],
      });
      res.json({ clientSecret: paymentIntent.client_secret });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post("/", verifyJwt, async (req, res) => {
    try {
      const { orderId, email, amount, paymentMethod, transactionId } = req.body;

      const updateResult = await ordersCollection.updateOne(
        { _id: new ObjectId(orderId) },
        {
          $set: {
            payment_status: "paid",
            status: "not_assigned",
            paidAt: new Date().toISOString(),
          },
        }
      );

      if (updateResult.modifiedCount === 0) {
        return res
          .status(404)
          .send({ message: "Order not found or already paid" });
      }

      const paymentDoc = {
        orderId,
        email,
        amount,
        paymentMethod,
        transactionId,
        paidAt: new Date().toISOString(),
        status: "payment done",
      };

      const paymentResult = await paymentsCollection.insertOne(paymentDoc);

      const notificationForUser = {
        type: "direct",
        email,
        message: `Your payment is successfully done. Go to my orders and you can download your reciept.`,
        relatedId: orderId.toString(),
        createdAt: new Date().toISOString(),
        isRead: false,
      };

      await notificationsCollection.insertOne(notificationForUser);

      const notificationForAdmin = {
        type: "direct",
        email: "sarfarazakram16@gmail.com",
        message: `Get payment successfully.`,
        relatedId: orderId.toString(),
        createdAt: new Date().toISOString(),
        isRead: false,
      };

      await notificationsCollection.insertOne(notificationForAdmin);

      res.status(201).send({
        message: "Payment recorded and parcel marked as paid",
        insertedId: paymentResult.insertedId,
      });
    } catch (error) {
      res.status(500).send({ message: "Failed to record payment" });
    }
  });

  return router;
};
