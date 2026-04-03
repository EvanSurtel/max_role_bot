const paypal = require('@paypal/checkout-server-sdk');

function environment() {
	let clientId = process.env.PP_CLIENT_ID;
	let clientSecret = process.env.PP_SECRET;

	return process.env.NODE_ENV === 'production'
		? new paypal.core.LiveEnvironment(clientId, clientSecret)
		: new paypal.core.SandboxEnvironment(clientId, clientSecret);
}

async function createPayment(amount) {
	const request = new paypal.orders.OrdersCreateRequest();
	request.prefer('return=representation');
	request.requestBody({
		intent: 'CAPTURE',
		purchase_units: [
			{
				amount: {
					currency_code: 'USD', // Adjust the currency code as needed
					value: amount.toString(),
				},
			},
		],
	});

	try {
		const response = await client.execute(request);
		return response.result.links.find((link) => link.rel === 'approve').href;
	} catch (err) {
		console.error(err);
		throw err; // Or handle the error as per your application's requirement
	}
}

async function processWithdrawal(userId, amount) {
	const request = new paypal.payouts.PayoutsPostRequest();
	request.requestBody({
		sender_batch_header: {
			sender_batch_id: `payout_${Date.now()}`, // Unique batch ID
			email_subject: 'You have a payout!',
			email_message:
				'You have received a payout! Thanks for using our service!',
		},
		items: [
			{
				recipient_type: 'EMAIL',
				amount: {
					value: amount.toString(),
					currency: 'USD',
				},
				receiver: 'USER_EMAIL@example.com', // Replace with the actual recipient's PayPal email
				note: 'Thanks for your participation!',
				sender_item_id: `payout_item_${Date.now()}`,
			},
		],
	});

	try {
		const response = await client.execute(request);
		return response.result; // Or handle as needed
	} catch (err) {
		console.error(err);
		throw err; // Or handle the error as per your application's requirement
	}
}

let client = new paypal.core.PayPalHttpClient(environment());

module.exports = {
	createPayment,
	processWithdrawal,
};
