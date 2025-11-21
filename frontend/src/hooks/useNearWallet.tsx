import {
  createContext,
  useContext,
  useEffect,
  useState,
  useMemo,
  ReactNode,
} from "react";
import { JsonRpcProvider } from "@near-js/providers";
import {
  NearConnector,
  type NearWalletBase,
  type Plugin,
  type SignAndSendTransactionParams,
} from "@hot-labs/near-connect";
import { Account } from "@near-js/accounts";
import { KeyPair } from "@near-js/crypto";
import { KeyPairSigner } from "@near-js/signers";
import { actionCreators } from "@near-js/transactions";
import type { FinalExecutionOutcome } from "@near-js/types";

interface ViewFunctionParams {
  contractId: string;
  method: string;
  args?: Record<string, unknown>;
}

interface FunctionCallParams {
  contractId: string;
  method: string;
  args?: Record<string, unknown>;
  gas?: string;
  deposit?: string;
}

interface AccessKeyConfig {
  contractId: string;
  allowedMethods: string[];
  allowance?: string;
}

interface StoredKeyData {
  accountId: string;
  publicKey: string;
  privateKey: string;
  contractId: string;
  allowedMethods: string[];
}

interface NearContextValue {
  signedAccountId: string;
  wallet: NearWalletBase | undefined;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  loading: boolean;
  viewFunction: (params: ViewFunctionParams) => Promise<any>;
  callFunction: (params: FunctionCallParams) => Promise<any>;
  provider: JsonRpcProvider;
}

interface NearProviderProps {
  children: ReactNode;
  network?: "testnet" | "mainnet";
  contractId: string;
  allowedMethods?: string[];
}

const NearContext = createContext<NearContextValue | undefined>(undefined);

const RPC_URLS = {
  testnet: "https://test.rpc.fastnear.com",
  mainnet: "https://rpc.fastnear.com",
};

const AccessKeyPlugin = (config: AccessKeyConfig, provider: JsonRpcProvider): Plugin => {
  const STORAGE_KEY = `access_key_${config.contractId}`;
  const checkFunctionCallKey = async (accountId: string, publicKey: string) => {
    const result: any = await provider.query({
      request_type: "view_access_key",
      account_id: accountId,
      public_key: publicKey,
      finality: "final",
    });

    return result.permission?.FunctionCall?.receiver_id === config.contractId;
  };

  const shouldUseAccessKey = (tx: SignAndSendTransactionParams): boolean => {
    if (
      tx.receiverId !== config.contractId ||
      !localStorage.getItem(STORAGE_KEY)
    )
      return false;

    for (const action of tx.actions) {
      if (action.type !== "FunctionCall") return false;
      if (!config.allowedMethods.includes(action.params.methodName))
        return false;
    }

    return true;
  };

  const signTransactionLocally = async (
    tx: SignAndSendTransactionParams
  ): Promise<FinalExecutionOutcome> => {
    const keyData = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");

    const keyInfo: any = await provider.query({
      request_type: "view_access_key",
      account_id: keyData.accountId,
      public_key: keyData.publicKey,
      finality: "final",
    });

    const allowanceLeft = keyInfo.permission.FunctionCall.allowance;

    if (allowanceLeft === "0" || allowanceLeft === 0) {
      console.warn("[AccessKeyPlugin] Access key has no allowance left");
      localStorage.removeItem(STORAGE_KEY);
      throw new Error(
        "Access key has no allowance left. Please sign in again."
      );
    }

    const keyPair = KeyPair.fromString(keyData.privateKey as any);

    const signer = new KeyPairSigner(keyPair);

    const account = new Account(keyData.accountId, provider, signer);

    const actions = tx.actions.map((action) => {
      if (action.type === "FunctionCall") {
        const argsBytes = new TextEncoder().encode(
          JSON.stringify(action.params.args || {})
        );

        return actionCreators.functionCall(
          action.params.methodName,
          argsBytes,
          BigInt(action.params.gas || "30000000000000"),
          BigInt(action.params.deposit || "0")
        );
      }
      throw new Error(`Unsupported action type: ${action.type}`);
    });

    try {
      const result = await account.signAndSendTransaction({
        receiverId: tx.receiverId,
        actions,
      });
      return result as FinalExecutionOutcome;
    } catch (error) {
      console.error("[AccessKeyPlugin] Error signing transaction:", error);
      throw error;
    }
  };
  return {
    async signIn(wallet, args, result, next) {
      const modifiedArgs = {
        ...args,
        contractId: args?.contractId || config.contractId,
        methodNames: args?.methodNames || config.allowedMethods || [],
      };

      const accounts = await next(modifiedArgs);
      const walletAccounts = await wallet.getAccounts();
      const publicKey = walletAccounts?.[0]?.publicKey;
      const accountId = accounts[0].accountId;

      const hasFunctionCallKey = await checkFunctionCallKey(
        accountId,
        publicKey
      );

      if (!hasFunctionCallKey) {
        const keyPair = KeyPair.fromRandom("ed25519");
        const newPublicKey = keyPair.getPublicKey().toString();
        const privateKey = keyPair.toString();

        try {
          await wallet.signAndSendTransaction({
            receiverId: accountId,
            actions: [
              {
                type: "AddKey",
                params: {
                  publicKey: newPublicKey,
                  accessKey: {
                    permission: {
                      receiver_id: config.contractId,
                      method_names: config.allowedMethods || [],
                      allowance: "250000000000000000000000",
                    },
                  },
                },
              },
            ],
          });

          localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({
              accountId,
              publicKey: newPublicKey,
              privateKey,
              contractId: config.contractId,
              allowedMethods: config.allowedMethods,
            })
          );
        } catch (e) {
          if (
            !(
              e instanceof Error &&
              (e.message.includes("User rejected the transactions") ||
              e.message.includes("User closed the window before completing the action"))
            )
          ) {
            await wallet.signAndSendTransaction({
              receiverId: accountId,
              actions: [
                {
                  type: "AddKey",
                  params: {
                    publicKey: newPublicKey,
                    accessKey: {
                      permission: {
                        receiverId: config.contractId,
                        methodNames: config.allowedMethods || [],
                        allowance: "250000000000000000000000",
                      },
                    },
                  },
                },
              ],
            });
            localStorage.setItem(
              STORAGE_KEY,
              JSON.stringify({
                accountId,
                publicKey: newPublicKey,
                privateKey,
                contractId: config.contractId,
                allowedMethods: config.allowedMethods,
              })
            );
          }
        }
      }

      return result(accounts);
    },

    async signOut(wallet, args, result, next) {
      localStorage.removeItem(STORAGE_KEY);
      await next(args);
      return result(undefined);
    },

    async signAndSendTransaction(_wallet, tx, result, next) {
      if (shouldUseAccessKey(tx)) {

        const outcome = await signTransactionLocally(tx);

        return result(outcome);
      }
      const outcome = await next(tx);
      return result(outcome);
    },
  };
};

export function NearProvider({
  children,
  network = "testnet",
  contractId,
  allowedMethods = []
}: NearProviderProps) {
  const [wallet, setWallet] = useState<NearWalletBase | undefined>(undefined);
  const [signedAccountId, setSignedAccountId] = useState("");
  const [loading, setLoading] = useState(true);

  const provider = useMemo(
    () => new JsonRpcProvider({ url: RPC_URLS[network] }),
    [network]
  );

  const connector = useMemo(() => {
    const conn = new NearConnector({
      network,
      logger: {
        log: (...logs) => console.log("[HOT-CONNECTOR]", ...logs),
      },
    });

    conn.use(
      AccessKeyPlugin(
        {
          contractId,
          allowedMethods,
        },
        provider
      )
    );

    return conn;
  }, [network, contractId, allowedMethods, provider]);

  useEffect(() => {
    async function initializeConnector() {
      const connectedWallet = await connector
        .getConnectedWallet()
        .catch(() => null);

      if (connectedWallet) {
        setWallet(connectedWallet.wallet);
        setSignedAccountId(connectedWallet.accounts[0].accountId);
      }

      const onSignOut = () => {
        setWallet(undefined);
        setSignedAccountId("");
      };

      const onSignIn = async (payload: { wallet: NearWalletBase }) => {
        setWallet(payload.wallet);
        const accounts = await payload.wallet.getAccounts();
        setSignedAccountId(accounts[0]?.accountId || "");
      };

      connector.on("wallet:signOut", onSignOut);
      connector.on("wallet:signIn", onSignIn);
      setLoading(false);
    }

    initializeConnector();

    return () => {
      if (connector) {
        connector.removeAllListeners("wallet:signOut");
        connector.removeAllListeners("wallet:signIn");
      }
    };
  }, [connector]);

  async function signIn() {
    if (!connector) return;
    const wallet = await connector.connect();

    console.log("Connected wallet", wallet);
    if (wallet) {
      setWallet(wallet);
      const accounts = await wallet.getAccounts();
      setSignedAccountId(accounts[0]?.accountId || "");
    }
  }

  async function signOut() {
    if (!connector || !wallet) return;
    await connector.disconnect(wallet);
    console.log("Disconnected wallet");

    setWallet(undefined);
    setSignedAccountId("");
  }

  async function viewFunction({
    contractId,
    method,
    args = {},
  }: ViewFunctionParams) {
    return provider.callFunction(contractId, method, args);
  }

  async function callFunction({
    contractId,
    method,
    args = {},
    gas = "30000000000000",
    deposit = "0",
  }: FunctionCallParams) {
    const wallet = await connector.wallet();

    return wallet.signAndSendTransaction({
      signerId: signedAccountId,
      receiverId: contractId,
      actions: [
        {
          type: "FunctionCall",
          params: {
            methodName: method,
            args,
            gas,
            deposit,
          },
        },
      ],
    });
  }

  const value: NearContextValue = {
    signedAccountId,
    wallet,
    signIn,
    signOut,
    loading,
    viewFunction,
    callFunction,
    provider,
  };

  return <NearContext.Provider value={value}>{children}</NearContext.Provider>;
}

export function useNearWallet() {
  const context = useContext(NearContext);
  if (context === undefined) {
    throw new Error("useNear must be used within a NearProvider");
  }
  return context;
}
