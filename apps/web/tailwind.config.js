/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#EFF8F1",
          100: "#D9ECDE",
          200: "#B6DABF",
          300: "#8CC49B",
          400: "#5DAA72",
          500: "#348A4F",
          600: "#236F3C",
          700: "#0B3C1D",
          800: "#092F18",
          900: "#072413"
        }
      }
    }
  },
  plugins: []
};
