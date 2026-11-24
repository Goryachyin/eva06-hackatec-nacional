/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        clinical: {
          bg: "#FFFFFF",
          surface: "#F7F8F9",
          emerald: "#00875A",
          "emerald-dark": "#006B47",
          action: "#E86A17",
          "action-dark": "#CF5B0E",
          ink: "#1F2933",
          muted: "#52606D",
          line: "#E4E7EB",
          danger: "#B42318",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
      },
    },
  },
  plugins: [],
};
