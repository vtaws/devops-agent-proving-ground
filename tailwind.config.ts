import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        aws: {
          orange: "#FF9900",
          dark: "#232F3E",
          light: "#F2F3F3",
          blue: "#147EBA",
          red: "#D13212",
          green: "#1D8102",
        },
      },
    },
  },
  plugins: [],
};

export default config;
