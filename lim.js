import "dotenv/config";
import { ethers } from "ethers";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const {
  PRIVATE_KEY,
  RPC_URL,
  CHAIN_ID,
  USDSC_ADDRESS,
  STARTALE_QUOTE_URL,
  PARTNER_FEE_BPS,
  SLIPPAGE,
} = process.env;

function requireEnv(name, value) {
  if (!value) {
    console.error(`Missing ${name} in .env. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return value;
}

requireEnv("PRIVATE_KEY", PRIVATE_KEY);
requireEnv("RPC_URL", RPC_URL);
requireEnv("CHAIN_ID", CHAIN_ID);
requireEnv("USDSC_ADDRESS", USDSC_ADDRESS);
requireEnv("STARTALE_QUOTE_URL", STARTALE_QUOTE_URL);

const NATIVE_ETH_PLACEHOLDER = ethers.ZeroAddress; // "0x000...000", dipakai Startale untuk menandakan ETH native

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

const provider = new ethers.JsonRpcProvider(RPC_URL, Number(CHAIN_ID));
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const usdsc = new ethers.Contract(USDSC_ADDRESS, ERC20_ABI, wallet);

// ---------------------------------------------------------------------
// Encoder untuk request payload (meniru format yang diamati dari trafik
// nyata app.startale.com - format tag {t,i,p,k,v} mirip skema serialisasi
// "devalue"/"seroval").
// ---------------------------------------------------------------------
function buildQuotePayload({ tokenIn, tokenOut, amountInWei }) {
  const inner = {
    t: 10,
    i: 1,
    p: {
      k: ["chainId", "tokenIn", "tokenOut", "userAddress", "amountIn", "amountOut", "partnerFeeBps", "slippage"],
      v: [
        { t: 0, s: Number(CHAIN_ID) },
        { t: 1, s: tokenIn },
        { t: 1, s: tokenOut },
        { t: 1, s: wallet.address },
        { t: 3, s: amountInWei.toString() },
        { t: 2, s: 1 },
        { t: 0, s: Number(PARTNER_FEE_BPS || 85) },
        { t: 0, s: Number(SLIPPAGE || 0.01) },
      ],
    },
    o: 0,
  };
  const outer = {
    t: { t: 10, i: 0, p: { k: ["data"], v: [inner] }, o: 0 },
    f: 63,
    m: [],
  };
  return JSON.stringify(outer);
}

// ---------------------------------------------------------------------
// Decoder generik untuk response bertag {t,i,p,k,v,a,s,o} dari server.
// ---------------------------------------------------------------------
function resolveNode(node) {
  if (node === null || typeof node !== "object") return node;
  switch (node.t) {
    case 0: // number literal
    case 1: // string literal
    case 2: // flag/boolean-ish literal
      return node.s;
    case 3: // BigInt yang dikirim sebagai string
      return node.s;
    case 9: { // array
      return (node.a || []).map(resolveNode);
    }
    case 10: // object (keys literal, values bertag, index sejajar)
    case 11: {
      const out = {};
      const keys = (node.p && node.p.k) || [];
      const vals = (node.p && node.p.v) || [];
      keys.forEach((key, idx) => {
        out[key] = resolveNode(vals[idx]);
      });
      return out;
    }
    default:
      return node.s !== undefined ? node.s : node;
  }
}

async function fetchSwapRoute({ tokenIn, tokenOut, amountInWei }) {
  const payload = buildQuotePayload({ tokenIn, tokenOut, amountInWei });
  const url = `${STARTALE_QUOTE_URL}?payload=${encodeURIComponent(payload)}`;

  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "*/*" },
  });

  if (!res.ok) {
    throw new Error(
      `Gagal ambil rute dari Startale (HTTP ${res.status}). Endpoint mungkin sudah berubah - lihat README.md untuk cara menemukan URL baru.`
    );
  }

  const raw = await res.json();
  const resolved = resolveNode(raw);

  if (!resolved || !resolved.result) {
    throw new Error(
      "Format response tidak dikenali (endpoint mungkin sudah berubah): " + JSON.stringify(raw).slice(0, 300)
    );
  }

  const { toAddress, calldata, quote } = resolved.result;
  if (!toAddress || !calldata) {
    throw new Error("Response tidak berisi toAddress/calldata yang diharapkan.");
  }

  return {
    to: ethers.getAddress(toAddress),
    data: calldata.startsWith("0x") ? calldata : `0x${calldata}`,
    quote,
  };
}

// ---------------------------------------------------------------------
// Swap: ETH -> USDSC
// ---------------------------------------------------------------------
async function swapEthToUsdsc(amountEthStr) {
  const amountIn = ethers.parseEther(amountEthStr);

  const ethBalance = await provider.getBalance(wallet.address);
  if (ethBalance < amountIn) {
    throw new Error(
      `Saldo ETH tidak cukup. Punya ${ethers.formatEther(ethBalance)} ETH, butuh ${amountEthStr} ETH (+ gas).`
    );
  }

  console.log("Meminta rute swap dari Startale...");
  const { to, data, quote } = await fetchSwapRoute({
    tokenIn: NATIVE_ETH_PLACEHOLDER,
    tokenOut: USDSC_ADDRESS,
    amountInWei: amountIn,
  });

  if (quote) {
    console.log(`Estimasi amountOut (raw units): ${quote.amountOut}, minOutput: ${quote.minOutputAmount}`);
  }
  console.log(`Tujuan transaksi: ${to}`);

  console.log(`Mengirim swap ${amountEthStr} ETH -> USDSC ...`);
  const tx = await wallet.sendTransaction({ to, data, value: amountIn });
  console.log(`Tx terkirim: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`Selesai di block ${receipt.blockNumber}, status: ${receipt.status === 1 ? "sukses" : "gagal"}`);
}

// ---------------------------------------------------------------------
// Swap: USDSC -> ETH
// ---------------------------------------------------------------------
async function swapUsdscToEth(amountUsdscStr) {
  const decimals = await usdsc.decimals();
  const amountIn = ethers.parseUnits(amountUsdscStr, decimals);

  const balance = await usdsc.balanceOf(wallet.address);
  if (balance < amountIn) {
    throw new Error(
      `Saldo USDSC tidak cukup. Punya ${ethers.formatUnits(balance, decimals)}, butuh ${amountUsdscStr}.`
    );
  }

  console.log("Meminta rute swap dari Startale...");
  const { to, data, quote } = await fetchSwapRoute({
    tokenIn: USDSC_ADDRESS,
    tokenOut: NATIVE_ETH_PLACEHOLDER,
    amountInWei: amountIn,
  });

  if (quote) {
    console.log(`Estimasi amountOut (wei): ${quote.amountOut}, minOutput: ${quote.minOutputAmount}`);
  }
  console.log(`Tujuan transaksi: ${to}`);

  // Approve dulu ke alamat "to" (router) kalau allowance belum cukup
  const allowance = await usdsc.allowance(wallet.address, to);
  if (allowance < amountIn) {
    console.log(`Mengirim approve USDSC ke ${to} ...`);
    const approveTx = await usdsc.approve(to, amountIn);
    await approveTx.wait();
    console.log(`Approve selesai: ${approveTx.hash}`);
  }

  console.log(`Mengirim swap ${amountUsdscStr} USDSC -> ETH ...`);
  const tx = await wallet.sendTransaction({ to, data });
  console.log(`Tx terkirim: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`Selesai di block ${receipt.blockNumber}, status: ${receipt.status === 1 ? "sukses" : "gagal"}`);
}

// ---------------------------------------------------------------------
// Quote saja (tanpa eksekusi transaksi)
// ---------------------------------------------------------------------
async function showQuote(direction, amountStr) {
  if (direction === "eth-to-usdsc") {
    const amountIn = ethers.parseEther(amountStr);
    const { quote } = await fetchSwapRoute({
      tokenIn: NATIVE_ETH_PLACEHOLDER,
      tokenOut: USDSC_ADDRESS,
      amountInWei: amountIn,
    });
    console.log(`${amountStr} ETH -> USDSC`);
    console.log(quote);
  } else if (direction === "usdsc-to-eth") {
    const decimals = await usdsc.decimals();
    const amountIn = ethers.parseUnits(amountStr, decimals);
    const { quote } = await fetchSwapRoute({
      tokenIn: USDSC_ADDRESS,
      tokenOut: NATIVE_ETH_PLACEHOLDER,
      amountInWei: amountIn,
    });
    console.log(`${amountStr} USDSC -> ETH`);
    console.log(quote);
  } else {
    throw new Error("Arah tidak dikenal. Gunakan eth-to-usdsc atau usdsc-to-eth.");
  }
}

// ---------------------------------------------------------------------
// Balance check
// ---------------------------------------------------------------------
async function showBalances() {
  const [ethBal, usdscBal, dec, sym] = await Promise.all([
    provider.getBalance(wallet.address),
    usdsc.balanceOf(wallet.address),
    usdsc.decimals(),
    usdsc.symbol().catch(() => "USDSC"),
  ]);
  console.log(`Alamat wallet : ${wallet.address}`);
  console.log(`Saldo ETH     : ${ethers.formatEther(ethBal)} ETH`);
  console.log(`Saldo ${sym}   : ${ethers.formatUnits(usdscBal, dec)} ${sym}`);
}

// ---------------------------------------------------------------------
// Menu interaktif
// ---------------------------------------------------------------------
async function runInteractiveMenu() {
  const rl = readline.createInterface({ input, output });

  const ask = (question) => rl.question(question);

  try {
    while (true) {
      console.log(`
=== Startale Soneium Swap ===
1. Swap ETH -> USDSC
2. Swap USDSC -> ETH
3. Cek saldo wallet
4. Cek quote/estimasi harga (tanpa eksekusi)
0. Keluar
`);
      const choice = (await ask("Pilih menu (0-4): ")).trim();

      try {
        if (choice === "1") {
          const amount = (await ask("Jumlah ETH yang mau di-swap: ")).trim();
          if (!amount) {
            console.log("Jumlah tidak boleh kosong.");
            continue;
          }
          const confirm = (await ask(`Konfirmasi: swap ${amount} ETH -> USDSC? (y/n): `)).trim().toLowerCase();
          if (confirm === "y" || confirm === "yes") {
            await swapEthToUsdsc(amount);
          } else {
            console.log("Dibatalkan.");
          }
        } else if (choice === "2") {
          const amount = (await ask("Jumlah USDSC yang mau di-swap: ")).trim();
          if (!amount) {
            console.log("Jumlah tidak boleh kosong.");
            continue;
          }
          const confirm = (await ask(`Konfirmasi: swap ${amount} USDSC -> ETH? (y/n): `)).trim().toLowerCase();
          if (confirm === "y" || confirm === "yes") {
            await swapUsdscToEth(amount);
          } else {
            console.log("Dibatalkan.");
          }
        } else if (choice === "3") {
          await showBalances();
        } else if (choice === "4") {
          const dir = (await ask("Arah (1 = ETH->USDSC, 2 = USDSC->ETH): ")).trim();
          const amount = (await ask("Jumlah: ")).trim();
          if (dir === "1") {
            await showQuote("eth-to-usdsc", amount);
          } else if (dir === "2") {
            await showQuote("usdsc-to-eth", amount);
          } else {
            console.log("Pilihan arah tidak dikenal.");
          }
        } else if (choice === "0") {
          console.log("Sampai jumpa.");
          break;
        } else {
          console.log("Pilihan tidak dikenal, coba lagi.");
        }
      } catch (err) {
        console.error("Error:", err.message || err);
      }
    }
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------
async function main() {
  const [, , command, arg1, arg2] = process.argv;

  // Tanpa argumen -> tampilkan menu interaktif
  if (!command) {
    await runInteractiveMenu();
    return;
  }

  try {
    switch (command) {
      case "balance":
        await showBalances();
        break;

      case "eth-to-usdsc":
        if (!arg1) throw new Error("Sertakan jumlah ETH, contoh: node swap.js eth-to-usdsc 0.001");
        await swapEthToUsdsc(arg1);
        break;

      case "usdsc-to-eth":
        if (!arg1) throw new Error("Sertakan jumlah USDSC, contoh: node swap.js usdsc-to-eth 5");
        await swapUsdscToEth(arg1);
        break;

      case "quote":
        if (!arg1 || !arg2) throw new Error("Contoh: node swap.js quote eth-to-usdsc 0.001");
        await showQuote(arg1, arg2);
        break;

      default:
        console.log(`Perintah tidak dikenal. Gunakan salah satu:
  node swap.js                              (buka menu interaktif)
  node swap.js balance
  node swap.js quote eth-to-usdsc <jumlah_eth>
  node swap.js quote usdsc-to-eth <jumlah_usdsc>
  node swap.js eth-to-usdsc <jumlah_eth>
  node swap.js usdsc-to-eth <jumlah_usdsc>`);
    }
  } catch (err) {
    console.error("Error:", err.message || err);
    process.exit(1);
  }
}

main();
