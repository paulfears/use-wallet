/**
 * Helpful resources:
 * https://github.com/PureStake/algosigner/blob/develop/docs/dApp-integration.md
 */
import BaseWallet from "./base";
import type { InitAlgodClient } from "./base";
import { PROVIDER_ID, NODE_TOKEN, NODE_SERVER, NODE_PORT } from "../constants";
import { providers } from "../providers";
import type { WalletProvider } from "../types";
import { TransactionsArray } from "../types";
import type { DecodedTransaction, DecodedSignedTransaction } from "../types";

type WindowExtended = { AlgoSigner: AlgoSigner } & Window & typeof globalThis;

type AlgoSignerTransaction = {
  txn: string;
  // array of addresses to sign with (defaults to the sender),
  // setting this to an empty array tells AlgoSigner
  // that this transaction is not meant to be signed
  signers?: [];
  multisig?: string; // address of a multisig wallet to sign with
};

type SupportedLedgers = "MainNet" | "TestNet" | "BetaNet" | "devmodenet";

type AlgoSigner = {
  connect: () => Promise<Record<string, never>>;
  accounts: (ledger: {
    ledger: SupportedLedgers;
  }) => Promise<{ address: string }[]>;
  signTxn: (transactions: AlgoSignerTransaction[]) => Promise<
    {
      txID: string;
      blob: string;
    }[]
  >;
  encoding: {
    msgpackToBase64(transaction: Uint8Array): string;
    byteArrayToString(transaction: Uint8Array): string;
  };
};

type InitWallet = {
  client: AlgoSigner;
  id: PROVIDER_ID;
  providers: typeof providers;
};

class AlgoSignerClient extends BaseWallet {
  #client: AlgoSigner;
  id: PROVIDER_ID;
  provider: WalletProvider;

  constructor(initAlgodClient: InitAlgodClient, initWallet: InitWallet) {
    super(initAlgodClient);

    this.#client = initWallet.client;
    this.id = initWallet.id;
    this.provider = initWallet.providers[this.id];
  }

  static async init() {
    const algosdk = (await import("algosdk")).default;

    const initAlgodClient: InitAlgodClient = {
      algosdk,
      token: NODE_TOKEN,
      server: NODE_SERVER,
      port: NODE_PORT,
    };

    if (
      typeof window == "undefined" ||
      (window as WindowExtended).AlgoSigner === undefined
    ) {
      throw new Error("AlgoSigner is not available.");
    }

    const algoSigner = (window as WindowExtended).AlgoSigner as AlgoSigner;

    const initWallet: InitWallet = {
      id: PROVIDER_ID.ALGO_SIGNER,
      client: algoSigner,
      providers: providers,
    };

    return new AlgoSignerClient(initAlgodClient, initWallet);
  }

  async connect() {
    await this.#client.connect();

    let ledger: SupportedLedgers = "MainNet";

    /** @todo remove env vars */
    // if (process.env.NEXT_PUBLIC_VERCEL_ENV === "betanet") {
    //   ledger = "BetaNet";
    // }

    // if (process.env.NEXT_PUBLIC_VERCEL_ENV === "testnet") {
    //   ledger = "TestNet";
    // }

    // if (!process.env.NEXT_PUBLIC_VERCEL_ENV) {
    //   ledger = "devmodenet";
    // }

    const accounts = await this.#client.accounts({
      ledger,
    });

    if (accounts.length === 0) {
      throw new Error(`No accounts found for ${this.provider}`);
    }

    const mappedAccounts = accounts.map(({ address }, index) => ({
      name: `AlgoSigner ${index + 1}`,
      address,
      providerId: this.provider.id,
    }));

    return {
      ...this.provider,
      accounts: mappedAccounts,
    };
  }

  async reconnect(onDisconnect: () => void) {
    if (
      window === undefined ||
      (window as WindowExtended).AlgoSigner === undefined
    ) {
      onDisconnect();
    }

    return null;
  }

  async disconnect() {
    return;
  }

  formatTransactionsArray(
    transactions: TransactionsArray
  ): AlgoSignerTransaction[] {
    const formattedTransactions = transactions.map(([type, txn]) => {
      const formattedTxn: AlgoSignerTransaction = {
        txn: txn[1],
      };

      if (type === "s") {
        formattedTxn.signers = [];
        const decoded = this.algosdk.decodeSignedTransaction(
          new Uint8Array(Buffer.from(txn, "base64"))
        );
        formattedTxn.txn = this.#client.encoding.msgpackToBase64(
          decoded.txn.toByte()
        );
      } else {
        const decoded = this.algosdk.decodeUnsignedTransaction(
          Buffer.from(txn, "base64")
        );
        formattedTxn.txn = this.#client.encoding.msgpackToBase64(
          decoded.toByte()
        );
      }

      return formattedTxn;
    });

    return formattedTransactions;
  }

  async signTransactions(activeAdress: string, transactions: Uint8Array[]) {
    // Decode the transactions to access their properties.
    const decodedTxns = transactions.map((txn) => {
      return this.algosdk.decodeObj(txn);
    }) as Array<DecodedTransaction | DecodedSignedTransaction>;

    // Marshal the transactions,
    // and add the signers property if they shouldn't be signed.
    const txnsToSign = decodedTxns.reduce<AlgoSignerTransaction[]>(
      (acc, txn, i) => {
        const txnObj: AlgoSignerTransaction = {
          txn: this.#client.encoding.msgpackToBase64(transactions[i]),
        };

        if (
          "txn" in txn ||
          this.algosdk.encodeAddress(txn["snd"]) !== activeAdress
        ) {
          txnObj.txn = this.#client.encoding.msgpackToBase64(
            this.algosdk.decodeSignedTransaction(transactions[i]).txn.toByte()
          );
          txnObj.signers = [];
        }

        acc.push(txnObj);

        return acc;
      },
      []
    );

    // Sign them with the client.
    const result = await this.#client.signTxn(txnsToSign);

    // Join the newly signed transactions with the original group of transactions.
    const signedTxns = result.reduce<Uint8Array[]>((acc, txn, i) => {
      if (txn) {
        acc.push(new Uint8Array(Buffer.from(txn.blob, "base64")));
      } else {
        acc.push(transactions[i]);
      }

      return acc;
    }, []);

    return signedTxns;
  }

  async signEncodedTransactions(transactions: TransactionsArray) {
    const transactionsToSign = this.formatTransactionsArray(transactions);
    const result = await this.#client.signTxn(transactionsToSign);

    if (!result) {
      throw new Error("Signing failed.");
    }

    const signedRawTransactions = result.reduce(
      (signedTxns: Uint8Array[], txn, currentIndex) => {
        if (txn) {
          signedTxns.push(new Uint8Array(Buffer.from(txn.blob, "base64")));
        }

        if (txn === null) {
          signedTxns.push(
            new Uint8Array(Buffer.from(transactions[currentIndex][1], "base64"))
          );
        }

        return signedTxns;
      },
      []
    );

    return signedRawTransactions;
  }
}

export default AlgoSignerClient.init().catch((e) => {
  if (typeof window !== "undefined") {
    console.info("error initializing AlgoSigner", e);
    return;
  }
});
