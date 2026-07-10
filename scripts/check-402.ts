import { PAYMENT_ENABLED, PAY_TO, PRICE } from '../src/config.js';
import { previewChallenge } from '../src/payment.js';

if (!PAYMENT_ENABLED) {
  console.error('PAYMENT_ENABLED is false. Missing one of:');
  for (const name of ['TINYDOCK_PAY_TO', 'OKX_API_KEY', 'OKX_SECRET_KEY', 'OKX_PASSPHRASE']) {
    console.error(`  ${process.env[name] ? '✓' : '✗'} ${name}`);
  }
  process.exit(1);
}

console.log(`price $${PRICE} → ${PAY_TO}`);

try {
  const challenge = await previewChallenge();
  console.log(`\nstatus: ${challenge.status}`);
  console.log('headers:', Object.keys(challenge.headers).join(', ') || '(none)');

  // OKX carries the challenge in the PAYMENT-REQUIRED header as base64 JSON, not the body.
  const encoded = challenge.headers['PAYMENT-REQUIRED'];
  if (encoded) {
    const decoded: unknown = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    console.log('\nPAYMENT-REQUIRED:', JSON.stringify(decoded, null, 2).slice(0, 1600));
  } else {
    console.log('body:', JSON.stringify(challenge.body, null, 2)?.slice(0, 800));
  }

  console.log(challenge.status === 402 ? '\n✓ 402 challenge built' : '\n✗ expected 402');
  process.exit(challenge.status === 402 ? 0 : 1);
} catch (err) {
  console.error('\n✗ failed:', err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.cause) console.error('cause:', String(err.cause).slice(0, 400));
  process.exit(1);
}
