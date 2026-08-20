import * as React from "react"

const MOBILE_BREAKPOINT = 768
// Tailwind's `lg:` breakpoint — the boundary the desktop/mobile class pairs
// (`hidden lg:block` / `lg:hidden`) already switch on.
const DESKTOP_BREAKPOINT = 1024

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    onChange()
    if (typeof window.matchMedia !== "function") {
      window.addEventListener("resize", onChange)
      return () => window.removeEventListener("resize", onChange)
    }
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return !!isMobile
}

/**
 * True at Tailwind's `lg:` width or wider (>= 1024px). Same idiom as
 * useIsMobile — innerWidth is the value, matchMedia is only the change signal —
 * with two deliberate differences:
 *
 *  - the first value is computed synchronously instead of starting undefined,
 *    because callers use this to render ONE of two trees: a first paint at the
 *    wrong width would mount the phone layout on a desktop and then swap it.
 *  - matchMedia is optional. jsdom does not implement it, and a component that
 *    picks its layout by width must still render (at jsdom's 1024px default:
 *    the desktop tree) rather than throw inside an effect.
 */
export function useIsDesktop() {
  const [isDesktop, setIsDesktop] = React.useState<boolean>(
    () => typeof window === "undefined" || window.innerWidth >= DESKTOP_BREAKPOINT,
  )

  React.useEffect(() => {
    const onChange = () => setIsDesktop(window.innerWidth >= DESKTOP_BREAKPOINT)
    onChange()
    if (typeof window.matchMedia !== "function") return
    const mql = window.matchMedia(`(min-width: ${DESKTOP_BREAKPOINT}px)`)
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return isDesktop
}
