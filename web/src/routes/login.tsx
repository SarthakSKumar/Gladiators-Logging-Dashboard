import { useMutation } from "@tanstack/react-query"
import { ArrowLeft, Loader2 } from "lucide-react"
import { useEffect, useState } from "react"
import { Wordmark } from "@/components/brand"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp"
import { Label } from "@/components/ui/label"
import { post } from "@/lib/api"

export function LoginPage() {
  const [step, setStep] = useState<"email" | "code">("email")
  const [email, setEmail] = useState("")
  const [code, setCode] = useState("")
  const [cooldown, setCooldown] = useState(0)

  useEffect(() => {
    if (!cooldown) return
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [cooldown])

  const send = useMutation({
    mutationFn: () => post("/api/auth/request-otp", { email: email.trim() }),
    meta: { silent: true },
    onSuccess: () => {
      setStep("code")
      setCode("")
      setCooldown(60)
    },
  })
  const verify = useMutation({
    mutationFn: (c: string) => post("/api/auth/verify-otp", { email: email.trim(), code: c }),
    meta: { silent: true },
    onSuccess: () => window.location.replace("/"),
    onError: () => setCode(""),
  })
  const error = (step === "email" ? send.error : verify.error ?? send.error)?.message

  return (
    <main className="flex min-h-svh items-center justify-center bg-sidebar px-4 py-10">
      <div className="w-full max-w-sm">
        <Wordmark className="mb-8 justify-center" subtitle={false} />
        <div className="rounded-xl border bg-background p-6 shadow-sm">
          {step === "email" ? (
            <form
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault()
                if (email.trim()) send.mutate()
              }}
            >
              <div>
                <h1 className="text-lg font-semibold tracking-tight">Sign in</h1>
                <p className="mt-1 text-sm text-muted-foreground">We’ll email you a one-time code.</p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" autoComplete="email" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              {error && (
                <p role="alert" className="text-sm text-danger">
                  {error}
                </p>
              )}
              <Button type="submit" disabled={send.isPending || !email.trim()}>
                {send.isPending && <Loader2 className="animate-spin" />}
                Send code
              </Button>
              <Button type="button" variant="link" size="sm" className="justify-self-center text-muted-foreground" disabled={!email.trim()} onClick={() => setStep("code")}>
                I already have a code
              </Button>
            </form>
          ) : (
            <form
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault()
                if (code.length === 6) verify.mutate(code)
              }}
            >
              <div>
                <h1 className="text-lg font-semibold tracking-tight">Check your email</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  Enter the 6-digit code sent to <span className="font-medium text-foreground">{email.trim()}</span>. It expires in 10 minutes.
                </p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="otp">Code</Label>
                <InputOTP
                  id="otp"
                  maxLength={6}
                  value={code}
                  autoFocus
                  inputMode="numeric"
                  pattern="^[0-9]*$"
                  onChange={setCode}
                  onComplete={(c: string) => verify.mutate(c)}
                  disabled={verify.isPending}
                >
                  <InputOTPGroup className="w-full justify-between *:data-[slot=input-otp-slot]:size-11 *:data-[slot=input-otp-slot]:text-base *:data-[slot=input-otp-slot]:tabular-nums">
                    {Array.from({ length: 6 }, (_, i) => (
                      <InputOTPSlot key={i} index={i} />
                    ))}
                  </InputOTPGroup>
                </InputOTP>
              </div>
              {error && (
                <p role="alert" className="text-sm text-danger">
                  {error}
                </p>
              )}
              <Button type="submit" disabled={verify.isPending || code.length !== 6}>
                {verify.isPending && <Loader2 className="animate-spin" />}
                Sign in
              </Button>
              <div className="flex items-center justify-between text-sm">
                <Button type="button" variant="ghost" size="sm" className="-ml-2" onClick={() => setStep("email")}>
                  <ArrowLeft /> Different email
                </Button>
                <Button type="button" variant="link" size="sm" disabled={cooldown > 0 || send.isPending} onClick={() => send.mutate()}>
                  {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend code"}
                </Button>
              </div>
            </form>
          )}
        </div>
        <p className="mt-6 text-center text-xs text-muted-foreground">Only authorised admins can sign in.</p>
      </div>
    </main>
  )
}
