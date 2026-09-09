/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Live Stellar Testnet payout leg — proves the #40 provider-payout flow
 * against a REAL deployed multisig contract, end-to-end:
 *
 *   1. Deploy a FRESH multisig (threshold 1, signer = journey signer) bound
 *      to the journey's self-issued USDC via its Stellar Asset Contract
 *   2. Fund the multisig account with XLM + USDC (classic asset — the SAC
 *      wraps it 1:1, so the contract can transfer it)
 *   3. Restart the gateway with PAYOUT_AUTOMATION_ENABLED=true and the new
 *      MULTISIG_CONTRACT / CONTRACT_ADMIN_SECRET (see testnet-journey.sh)
 *   4. Authenticate as the provider owner (challenge/verify, real Ed25519)
 *   5. POST /api/v1/admin/payouts/propose → threshold-1 auto-approve
 *   6. Verify: proposal `executed`, provider payout wallet holds the USDC
 *
 * Evidence (full tx hashes, contract ID, balances) is appended to
 * docs/evidence/testnet-journey.json under `payout`. Deterministic failure:
 * any unexpected status fails the run.
 *
 * Run via `scripts/testnet-journey.sh` (payout leg) or with the env vars
 * below set and the gateway already booted with payout env.
 */
import {
  Keypair,
  Operation,
  Asset,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  Horizon,
  xdr,
  StrKey,
  Address,
  rpc,
} from '@stellar/stellar-sdk';
import { createHash } from 'crypto';
import { prisma } from '@x402/database';

// ── Config ────────────────────────────────────

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:3000';
const HORIZON_URL = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
const RPC_URL = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
const FRIENDBOT_URL = process.env.FRIENDBOT_URL || 'https://friendbot.stellar.org';
const ISSUER_SECRET = process.env.ISSUER_SECRET || '';
const SIGNER_SECRET = process.env.PAYOUT_SIGNER_SECRET || '';
const MULTISIG_WASM =
  process.env.MULTISIG_WASM ||
  'contracts/multisig/target/wasm32-unknown-unknown/release/multisig.wasm';
const STATE_FILE = process.env.PAYOUT_STATE_FILE || '.testnet-journey/payout-state.json';
/** "deploy" writes the fresh contract id + funds it; "run" proposes via the gateway. */
const MODE = process.env.PAYOUT_MODE || 'run';
const NETWORK_PASSPHRASE = Networks.TESTNET;

if (!ISSUER_SECRET || !SIGNER_SECRET) {
  throw new Error('ISSUER_SECRET and PAYOUT_SIGNER_SECRET are required');
}

const issuer = Keypair.fromSecret(ISSUER_SECRET);
const signer = Keypair.fromSecret(SIGNER_SECRET);
const USDC_ISSUER = issuer.publicKey();
const USDC_ASSET = new Asset('USDC', USDC_ISSUER);

// ── Horizon + RPC helpers ─────────────────────

const server = new Horizon.Server(HORIZON_URL, {
  allowHttp: HORIZON_URL.startsWith('http://'),
});

// Soroban RPC server for contract deployment simulation/submission.
const rpcServer = new rpc.Server(RPC_URL);

/**
 * Register the protocol-23+ `CREATE_CONTRACT_V2_HOST_FN` auth arm on the
 * bundled XDR (stellar-base 12.x predates protocol 23). Testnet now runs
 * protocol 23+, so create-contract simulations return an auth entry whose
 * `SorobanAuthorizedFunctionType` member (2) the old XDR cannot parse. The
 * arm's shape is `CreateContractArgsV2` (preimage + executable + constructor
 * args) — every piece already exists in the old XDR, so we register a custom
 * arm that reads/writes it with the existing types.
 *
 * Idempotent: a second call is a no-op. This is safe because the extension
 * only ADDS an arm; the existing members are untouched.
 */
function extendXdrForCreateV2(): void {
  const T = xdr.SorobanAuthorizedFunctionType as any;
  if (T._byValue && T._byValue[2]) return;
  const inst = new T('sorobanAuthorizedFunctionTypeCreateContractV2HostFn', 2);
  T._members['sorobanAuthorizedFunctionTypeCreateContractV2HostFn'] = inst;
  T._byValue[2] = inst;

  const CreateContractArgsV2: any = {
    read(reader: any) {
      return {
        contractIDPreimage: xdr.ContractIdPreimage.read(reader),
        executable: xdr.ContractExecutable.read(reader),
        constructorArgs: xdr.ScVec.read(reader),
      };
    },
    write(value: any, writer: any) {
      xdr.ContractIdPreimage.write(value.contractIDPreimage, writer);
      xdr.ContractExecutable.write(value.executable, writer);
      xdr.ScVec.write(value.constructorArgs, writer);
    },
    isValid() {
      return true;
    },
  };

  const U = xdr.SorobanAuthorizedFunction as any;
  U._switches.set(inst, 'createContractV2HostFn');
  U._arms['createContractV2HostFn'] = CreateContractArgsV2;
}

extendXdrForCreateV2();

// ── Evidence ──────────────────────────────────

const evidence: Record<string, any> = {
  runAt: new Date().toISOString(),
  steps: {},
};

function step(name: string, data: Record<string, any>) {
  evidence.steps[name] = data;
  console.log(`  ✓ ${name}`);
}

let stepFailures = 0;
function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`    ✅ ${name}`);
  } else {
    stepFailures++;
    console.error(`    ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function friendbotFund(address: string, label: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT_URL}/?addr=${address}`, { method: 'GET' });
  if (!res.ok) {
    const account = await server.loadAccount(address);
    if (account.balances.length === 0) {
      throw new Error(`friendbot failed for ${label} (${address}): ${res.status}`);
    }
    return;
  }
  const body: any = await res.json();
  await server.transactions().transaction(body.hash).call();
}

async function submitTx(tx: any, label: string): Promise<any> {
  try {
    return await server.submitTransaction(tx, { skipMemoRequiredCheck: true });
  } catch (err: any) {
    const detail =
      err?.response?.data?.extras?.result_codes || err?.response?.data?.detail || err?.message;
    throw new Error(`${label} submission failed: ${JSON.stringify(detail)}`);
  }
}

async function buildSigned(
  secret: string,
  label: string,
  ops: any[],
): Promise<{ txXdr: string; txHash: string }> {
  const keypair = Keypair.fromSecret(secret);
  const account = await server.loadAccount(keypair.publicKey());
  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  });
  for (const op of ops) builder.addOperation(op);
  builder.setTimeout(300);
  const built = builder.build();
  built.sign(keypair);
  return { txXdr: built.toXDR(), txHash: built.hash().toString('hex') };
}

async function submitSigned(secret: string, txXdr: string, label: string): Promise<any> {
  const tx = TransactionBuilder.fromXDR(txXdr, NETWORK_PASSPHRASE);
  return submitTx(tx, label);
}

/**
 * Build a Soroban transaction with simulation (needed for upload/create).
 *
 * Uses the raw simulate response + assembleTransaction directly: the bundled
 * SDK's parsed `prepareTransaction` chokes on protocol-23 auth XDR for
 * create-contract ops (SorobanAuthorizedFunctionType v2), which is newer
 * than this SDK version. The raw path skips that parser.
 */
async function sorobanTx(secret: string, ops: any[], label: string): Promise<any> {
  const keypair = Keypair.fromSecret(secret);
  const account = await server.loadAccount(keypair.publicKey());
  const builder = new TransactionBuilder(account, {
    fee: '1000000',
    networkPassphrase: NETWORK_PASSPHRASE,
  });
  for (const op of ops) builder.addOperation(op);
  builder.setTimeout(300);
  const tx = builder.build();
  tx.sign(keypair);

  const sim = await rpcServer._simulateTransaction(tx);
  if (sim.error) {
    throw new Error(`${label} simulation failed: ${sim.error}`);
  }
  // Protocol 23+ requires create-contract ops to carry the authorization the
  // simulator computed (returned in `results[i].auth`). Parse each entry with
  // the extended XDR (see extendXdrForCreateV2) and attach it to the op so
  // the assembled transaction is authorized.
  if (Array.isArray(sim.results)) {
    const ops = (tx as any)._tx.operations();
    sim.results.forEach((r: any, i: number) => {
      const entries = Array.isArray(r.auth) ? r.auth : [];
      if (entries.length > 0 && ops[i]) {
        const ihf = ops[i].body().invokeHostFunctionOp();
        ihf.auth(entries.map((a: string) => xdr.SorobanAuthorizationEntry.fromXDR(a, 'base64')));
      }
    });
  }
  // Assemble manually (NOT rpc.assembleTransaction): the bundled SDK's parser
  // chokes on protocol-23 create-contract auth XDR. The essential parts are
  // the soroban transaction data (footprint/resources) and the resource fee;
  // the auth entries above carry the per-op authorization.
  const sorobanData = xdr.SorobanTransactionData.fromXDR(sim.transactionData as string, 'base64');
  const minFee = parseInt(sim.minResourceFee as string, 10) || 0;
  const assembled = TransactionBuilder.cloneFrom(tx, {
    fee: (parseInt(tx.fee, 10) + minFee).toString(),
    sorobanData,
    networkPassphrase: NETWORK_PASSPHRASE,
  });
  const prepared = assembled.build();
  prepared.sign(keypair);
  const result = await submitTx(prepared, label);
  return result;
}

const balances = async (address: string): Promise<Array<{ asset: string; balance: string }>> =>
  (await server.loadAccount(address)).balances.map((b: any) => ({
    asset:
      b.asset_type === 'native' ? 'XLM' : `${b.asset_code}:${(b.asset_issuer || '').slice(0, 8)}`,
    balance: b.balance,
  }));

/** Non-negative stroop amount (i128) as an ScVal. */
function amountToScVal(amount: string): xdr.ScVal {
  const value = BigInt(amount);
  if (value < 0n) throw new Error('Amount must be non-negative');
  const lo = xdr.Uint64.fromString(value.toString());
  const hi = xdr.Int64.fromString('0');
  return xdr.ScVal.scvI128(new xdr.Int128Parts({ lo, hi }));
}

/**
 * Read an address's USDC balance tracked by the SAC (contract or account).
 * Classic Horizon balances don't see the contract's SAC-tracked USDC, so we
 * query the SAC `balance` function directly. Returns null on read failure.
 */
async function sacBalance(
  sacId: string,
  address: string,
): Promise<{ stroops: bigint; usdc: string } | null> {
  try {
    const account = await server.loadAccount(sacId);
    const builder = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    });
    builder.addOperation(
      Operation.invokeContractFunction({
        contract: sacId,
        function: 'balance',
        args: [xdr.ScVal.scvAddress(Address.fromString(address).toScAddress())],
      }),
    );
    builder.setTimeout(300);
    const tx = builder.build();
    tx.sign(signer);
    const sim: any = await rpcServer._simulateTransaction(tx);
    if (sim.error || !sim.results?.[0]?.xdr) {
      console.warn(
        `  (SAC balance read failed for ${address.slice(0, 8)}...: ${sim.error ?? 'no result'})`,
      );
      return null;
    }
    const result = xdr.ScVal.fromXDR(sim.results[0].xdr, 'base64');
    const native = (await import('@stellar/stellar-sdk')).scValToNative(result);
    const stroops = BigInt(native as number | string);
    return { stroops, usdc: (Number(stroops) / 1_000_000).toFixed(2) };
  } catch (err: any) {
    console.warn(`  (SAC balance read failed: ${err.message})`);
    return null;
  }
}

// ── Main ──────────────────────────────────────

async function main() {
  console.log('\n═══ x402 Live Testnet Payout Leg (#40) ═══');
  console.log(`  issuer  ${issuer.publicKey()}`);
  console.log(`  signer  ${signer.publicKey()}`);
  console.log(`  mode    ${MODE}`);
  const fs = await import('fs');
  fs.mkdirSync('.testnet-journey', { recursive: true });

  if (MODE === 'deploy') {
    await deployMultisig(fs);
    return;
  }
  await runPayout(fs);
}

/** Phase 1 — deploy + fund a fresh threshold-1 multisig; persist its id. */
async function deployMultisig(fs: typeof import('fs')) {
  // ── 1. Fund the signer (XLM) ──
  console.log('\n── Step 1: fund signer + issuer (friendbot, idempotent) ──');
  await friendbotFund(signer.publicKey(), 'signer');
  await friendbotFund(issuer.publicKey(), 'issuer');

  // ── 2. Deploy a fresh multisig bound to the journey USDC SAC ──
  console.log('\n── Step 2: deploy + init fresh multisig (threshold 1) ──');

  // The SAC for the journey's classic USDC asset — deterministic address.
  const assetXdr = USDC_ASSET.toXDRObject();
  const sacId = StrKey.encodeContract(
    createHash('sha256')
      .update(xdr.ContractIdPreimage.contractIdPreimageFromAsset(assetXdr).toXDR())
      .digest(),
  );
  console.log(`  USDC SAC: ${sacId}`);

  // The multisig id is deterministic (fixed salt + deployer address + network
  // passphrase), which makes the deploy phase idempotent: a re-run reuses the
  // existing contract. Protocol 23+ derives the id as
  //   sha256(HashIdPreimage{ networkID, contractIDPreimage })
  // which differs from the pre-protocol-23 plain preimage hash, so we derive
  // it explicitly rather than simulating a create (which fails once the
  // contract already exists).
  const salt = Buffer.alloc(32, 7); // fixed, reproducible salt
  const wasm = fs.readFileSync(MULTISIG_WASM);
  const wasmHash = createHash('sha256').update(wasm).digest();

  const contractIdPreimage = xdr.ContractIdPreimage.contractIdPreimageFromAddress(
    new xdr.ContractIdPreimageFromAddress({
      address: Address.fromString(signer.publicKey()).toScAddress(),
      salt,
    }),
  );
  const networkId = createHash('sha256').update(NETWORK_PASSPHRASE).digest();
  const idPreimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId,
      contractIdPreimage,
    }),
  );
  const multisigId = StrKey.encodeContract(
    createHash('sha256').update(idPreimage.toXDR()).digest(),
  );
  console.log(`  multisig (deterministic): ${multisigId}`);

  // Horizon `loadAccount` can't resolve contract accounts; query the RPC's
  // ledger entries for the contract's WASM code instead (empty = not deployed).
  let alreadyDeployed = false;
  {
    const contractCodeKey = xdr.LedgerKey.contractCode(
      new xdr.LedgerKeyContractCode({ hash: wasmHash }),
    );
    try {
      const entries: any = await rpcServer.getLedgerEntries(contractCodeKey);
      alreadyDeployed = Array.isArray(entries?.entries) && entries.entries.length > 0;
    } catch {
      alreadyDeployed = false;
    }
  }

  if (!alreadyDeployed) {
    // Upload the multisig wasm.
    const uploadResult = await sorobanTx(
      signer.secret(),
      [Operation.uploadContractWasm({ wasm })],
      'upload-wasm',
    );
    console.log(`  wasm uploaded: ${uploadResult.hash}`);
    step('deploy-upload', { txHash: uploadResult.hash, bytes: wasm.length });

    // Create the contract (auth entry is attached by sorobanTx).
    const createResult = await sorobanTx(
      signer.secret(),
      [
        Operation.createCustomContract({
          address: Address.fromString(signer.publicKey()),
          wasmHash,
          salt,
        }),
      ],
      'create-contract',
    );
    console.log(`  multisig deployed: ${multisigId}`);
    step('deploy-create', { txHash: createResult.hash, contractId: multisigId });

    // init(signers=[signer], threshold=1, token=SAC)
    const initResult = await sorobanTx(
      signer.secret(),
      [
        Operation.invokeContractFunction({
          contract: multisigId,
          function: 'init',
          args: [
            xdr.ScVal.scvVec([
              xdr.ScVal.scvAddress(Address.fromString(signer.publicKey()).toScAddress()),
            ]),
            xdr.ScVal.scvU32(1),
            xdr.ScVal.scvAddress(Address.fromString(sacId).toScAddress()),
          ],
        }),
      ],
      'multisig-init',
    );
    console.log(`  multisig init: ${initResult.hash}`);
    step('deploy-init', { txHash: initResult.hash });
  } else {
    console.log('  multisig already deployed — reusing (idempotent re-run)');
    step('deploy-reused', { contractId: multisigId });
  }

  // ── 3. Fund the multisig account (XLM + USDC via the SAC) ──
  console.log('\n── Step 3: fund multisig with XLM + USDC ──');

  // 3a. XLM for contract fees: the signer pays the contract account directly.
  // The SDK's `Operation.payment` rejects C-address destinations, so build the
  // PaymentOp XDR by hand (contract accounts are addressed by raw contract id).
  const xlmPaymentOp = new xdr.Operation({
    body: xdr.OperationBody.payment(
      new xdr.PaymentOp({
        destination: new xdr.MuxedAccount(
          xdr.CryptoKeyType.keyTypeEd25519(),
          StrKey.decodeContract(multisigId),
        ),
        asset: Asset.native().toXDRObject(),
        amount: xdr.Int64.fromString('5000000'), // 5 XLM in stroops
      }),
    ),
  });
  const xlmFund = await buildSigned(signer.secret(), 'fund-multisig-xlm', [xlmPaymentOp]);
  await submitSigned(signer.secret(), xlmFund.txXdr, 'fund-multisig-xlm');
  console.log(`  multisig funded with 5 XLM: ${xlmFund.txHash}`);

  // 3b. Signer trustline + issuer mints 10 USDC to the signer.
  const trustline = await buildSigned(signer.secret(), 'signer-trustline', [
    Operation.changeTrust({ asset: USDC_ASSET }),
  ]);
  await submitSigned(signer.secret(), trustline.txXdr, 'signer-trustline');
  console.log(`  signer USDC trustline: ${trustline.txHash}`);
  const mint = await buildSigned(issuer.secret(), 'mint-signer', [
    Operation.payment({ destination: signer.publicKey(), asset: USDC_ASSET, amount: '10' }),
  ]);
  await submitSigned(issuer.secret(), mint.txXdr, 'mint-signer');
  console.log(`  signer funded with 10 USDC: ${mint.txHash}`);

  // 3c. Credit the CONTRACT's balance through the SAC: `transfer` from the
  // signer to the multisig. Classic payments to a contract account would need
  // a trustline the contract cannot sign; the SAC wraps the classic asset 1:1
  // and tracks contract balances internally, so the contract can later pay out
  // via `token.transfer` (as `approve` does at quorum).
  const sacTransfer = await sorobanTx(
    signer.secret(),
    [
      Operation.invokeContractFunction({
        contract: sacId,
        function: 'transfer',
        args: [
          xdr.ScVal.scvAddress(Address.fromString(signer.publicKey()).toScAddress()),
          xdr.ScVal.scvAddress(Address.fromString(multisigId).toScAddress()),
          amountToScVal('10000000'), // 10 USDC in stroops
        ],
      }),
    ],
    'fund-multisig-sac',
  );
  console.log(`  multisig credited 10 USDC via SAC: ${sacTransfer.hash}`);
  step('fund-multisig', {
    xlmTxHash: xlmFund.txHash,
    sacTxHash: sacTransfer.hash,
    amount: '10 USDC',
    contractId: multisigId,
  });

  // Persist state for the `run` phase (gateway must boot with this id).
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(
      { multisigId, sacId, signer: signer.publicKey(), deployedAt: new Date().toISOString() },
      null,
      2,
    ),
  );
  console.log(`\n📄 Deploy state written to ${STATE_FILE}`);
  console.log('\n═══ DEPLOY PHASE DONE ✅ (restart the gateway, then run PAYOUT_MODE=run) ═══');
}

/** Phase 2 — seed provider revenue, auth, propose, verify (gateway must have payout env). */
async function runPayout(fs: typeof import('fs')) {
  if (!fs.existsSync(STATE_FILE)) {
    throw new Error(`No deploy state at ${STATE_FILE} — run PAYOUT_MODE=deploy first`);
  }
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  const multisigId: string = state.multisigId;
  const sacId: string = state.sacId;
  console.log(`  multisig ${multisigId} (from ${STATE_FILE})`);

  // ── 4. Provider: owned by the signer wallet, payout → signer wallet ──
  console.log('\n── Step 4: seed payout provider (owner = signer wallet) ──');
  const provider = await prisma.provider.upsert({
    where: { id: 'journey-payout-provider' },
    update: {
      walletAddress: signer.publicKey(),
      payoutWalletAddress: signer.publicKey(),
    },
    create: {
      id: 'journey-payout-provider',
      name: 'Testnet Payout Provider',
      walletAddress: signer.publicKey(),
      payoutWalletAddress: signer.publicKey(),
      active: true,
    },
  });
  // Confirmed revenue for the provider (as if the payer flow had run).
  await prisma.payment.create({
    data: {
      quoteId: `payout-quote-${Date.now()}`,
      routeId: 'journey-payout-route',
      providerId: provider.id,
      txHash: 'a'.repeat(64),
      payerAddress: 'G' + '1'.repeat(55),
      amount: 1_000_000n, // 1 USDC in stroops
      asset: 'USDC',
      status: 'confirmed',
      verifiedAt: new Date(),
    },
  });
  step('seed', { providerId: provider.id, revenueStroops: '1000000' });

  // ── 5. Auth as the provider owner (challenge → sign → verify) ──
  console.log('\n── Step 5: authenticate as provider owner (wallet auth) ──');
  const challengeRes = await fetch(`${GATEWAY_URL}/api/v1/auth/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: signer.publicKey() }),
  });
  const challengeBody: any = await challengeRes.json();
  check(
    'challenge created',
    challengeRes.status === 201 || challengeRes.status === 200,
    `${challengeRes.status}`,
  );
  const signature = Buffer.from(
    signer.sign(Buffer.from(challengeBody.challenge, 'utf-8')),
  ).toString('base64');
  const verifyRes = await fetch(`${GATEWAY_URL}/api/v1/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      challengeId: challengeBody.challengeId,
      address: signer.publicKey(),
      signature,
    }),
  });
  const verifyBody: any = await verifyRes.json();
  check(
    'auth verified',
    verifyRes.status === 200,
    `${verifyRes.status} ${JSON.stringify(verifyBody)}`,
  );
  const token = verifyBody.token;
  step('auth', { challengeId: challengeBody.challengeId, verified: verifyRes.status === 200 });

  // ── 6. Propose the payout → threshold-1 auto-approve ──
  console.log('\n── Step 6: POST /admin/payouts/propose (auto-approve at threshold 1) ──');
  const multisigUsdcBefore = await sacBalance(sacId, multisigId);
  const proposeRes = await fetch(`${GATEWAY_URL}/api/v1/admin/payouts/propose`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ providerId: provider.id }),
  });
  const proposeBody: any = await proposeRes.json();
  check(
    'propose accepted',
    proposeRes.status === 201,
    `${proposeRes.status} ${JSON.stringify(proposeBody)}`,
  );
  check(
    'auto-approved (threshold 1)',
    proposeBody?.autoApproved === true,
    `autoApproved=${proposeBody?.autoApproved}`,
  );
  check('executed', proposeBody?.status === 'executed', `status=${proposeBody?.status}`);
  step('propose', { response: proposeBody });

  // ── 7. Verify on-chain: proposal executed + payout wallet holds USDC ──
  console.log('\n── Step 7: verify on-chain + final balances ──');
  const signerB = await balances(signer.publicKey());
  const signerUsdc = signerB.find((b) => b.asset.startsWith('USDC'));
  const multisigUsdcAfter = await sacBalance(sacId, multisigId);
  check(
    'payout wallet holds ≥ 1 USDC (classic balance)',
    signerUsdc && Number(signerUsdc.balance) >= 1,
    signerUsdc?.balance,
  );
  const paidOut =
    multisigUsdcBefore && multisigUsdcAfter
      ? multisigUsdcBefore.stroops - multisigUsdcAfter.stroops
      : 0n;
  check(
    'multisig SAC balance reduced by ≥ 1 USDC (payout executed)',
    paidOut >= 1_000_000n,
    `before=${multisigUsdcBefore?.usdc} after=${multisigUsdcAfter?.usdc} diff=${(Number(paidOut) / 1_000_000).toFixed(2)}`,
  );
  step('balances', {
    signer: signerB,
    multisigSacBefore: multisigUsdcBefore,
    multisigSacAfter: multisigUsdcAfter,
    multisigContractId: multisigId,
    sacId,
  });

  // ── Evidence ──
  const outPath = process.env.EVIDENCE_PATH || 'docs/evidence/testnet-journey.json';
  const existing = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf-8')) : {};
  existing.payout = evidence;
  fs.writeFileSync(outPath, JSON.stringify(existing, null, 2));
  console.log(`\n📄 Payout evidence appended to ${outPath}`);

  console.log(
    `\n═══ ${stepFailures === 0 ? 'PAYOUT LEG PASSED ✅' : `${stepFailures} CHECKS FAILED ❌`} ═══`,
  );
  if (stepFailures > 0) process.exit(1);
}

main().catch((err) => {
  console.error('\nPayout leg failed:', err);
  process.exit(1);
});
