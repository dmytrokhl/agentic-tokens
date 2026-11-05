import { useEffect, useState } from "react";
import { fetchConfig } from "./api";

/** Editable demo OTP, prefilled only when the server confirms a sandbox vault. */
export function useOtpInput(prefillSandbox = true) {
  const [defaultOtp, setDefaultOtp] = useState("");
  const [enteredOtp, setEnteredOtp] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetchConfig().then((config) => {
      if (!cancelled) setDefaultOtp(prefillSandbox && config.vaultEnv === "sandbox" ? "111111" : "");
    }).catch(() => {
      // Config is optional for manual OTP entry; leave the default empty on failure.
    });
    return () => { cancelled = true; };
  }, [prefillSandbox]);

  return {
    otp: enteredOtp ?? defaultOtp,
    setOtp: (value: string) => setEnteredOtp(value),
    resetOtp: () => setEnteredOtp(undefined),
  };
}
