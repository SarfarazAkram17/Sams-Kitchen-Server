// Order pricing, worked out on the server from the foods in the database. The
// browser shows the same numbers, but only these are ever saved or charged.

export const DELIVERY_SINGLE_ITEM = 30;
export const DELIVERY_MULTIPLE_ITEMS = 50;
export const FREE_DELIVERY_FROM = 1000;

export const whole = (value) => Math.round(Number(value) || 0);

// Unit price after the percentage discount, rounded to a whole taka.
export const discountedPrice = (price, discount = 0) => {
  const base = Number(price) || 0;
  const percent = Number(discount) || 0;
  return whole(percent > 0 ? base - (base * percent) / 100 : base);
};

// Order lines from the cart (food ID and quantity) and the foods as they are in the database.
export const buildOrderItems = (lines, foodsById) =>
  lines.map(({ foodId, quantity }) => {
    const food = foodsById.get(foodId);
    const price = whole(food.price);
    const discount = Number(food.discount) || 0;
    return {
      foodId,
      name: food.name,
      image: food.image,
      price,
      discount,
      quantity,
      subtotal: discountedPrice(price, discount) * quantity,
    };
  });

// Subtotal (before food discounts), food discounts, delivery charge and total.
// Delivery is 30 for one dish, 50 for more, and free once the bill reaches 1000.
export const calcTotals = (items) => {
  const subtotal = items.reduce(
    (sum, item) => sum + item.price * item.quantity,
    0,
  );
  const discount = items.reduce(
    (sum, item) =>
      sum +
      (item.price - discountedPrice(item.price, item.discount)) * item.quantity,
    0,
  );

  let deliveryCharge =
    items.length > 1
      ? DELIVERY_MULTIPLE_ITEMS
      : items.length === 1
        ? DELIVERY_SINGLE_ITEM
        : 0;
  if (subtotal + deliveryCharge - discount >= FREE_DELIVERY_FROM)
    deliveryCharge = 0;

  return {
    subtotal,
    discount,
    deliveryCharge,
    total: subtotal + deliveryCharge - discount,
  };
};