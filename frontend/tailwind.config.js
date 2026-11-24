/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        sd: {
          green: "#00843D",
          "green-dark": "#005A2B",
          "green-hover": "#006E32",
          "green-light": "#E6F4EC",
          blue: "#0066B3",
          "blue-light": "#EBF4FC",
          slate: "#1E293B",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
      },
    },
  },
  plugins: [],
};
