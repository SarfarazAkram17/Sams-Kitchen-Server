require("dotenv").config();
const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);

module.exports = stripe;