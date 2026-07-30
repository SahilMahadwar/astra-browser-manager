import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        surface: {
          0: "#0a0b0d",
          1: "#101216",
          2: "#141720",
          3: "#161a21",
          4: "#1c2029",
          inset: "#0c0e12",
        },
        border: {
          DEFAULT: "#191d24",
          strong: "#1c2029",
          hover: "#2a303c",
          inset: "#171b22",
        },
        accent: {
          DEFAULT: "#57cf95",
          hover: "#65d9a1",
          fg: "#052014",
        },
        ink: {
          DEFAULT: "#e6e8ec",
          muted: "#9aa1af",
          faint: "#6b7280",
          ghost: "#3f4550",
        },
        danger: {
          DEFAULT: "#f28a82",
        },
      },
      fontFamily: {
        sans: ["Instrument Sans", "system-ui", "sans-serif"],
        display: ["Space Grotesk", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      borderRadius: {
        card: "14px",
        ctl: "9px",
        field: "10px",
        chip: "8px",
      },
      keyframes: {
        cbpulse: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.4" },
        },
        cbrise: {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        cbfade: {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
      },
      animation: {
        cbpulse: "cbpulse 2s ease-in-out infinite",
        cbrise: "cbrise .2s ease-out",
        cbfade: "cbfade .16s ease-out",
      },
    },
  },
  plugins: [],
} satisfies Config;
