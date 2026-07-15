import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        panel: "rgb(var(--panel) / <alpha-value>)",
        panel2: "rgb(var(--panel2) / <alpha-value>)",
        edge: "rgb(var(--edge) / <alpha-value>)",
        ink: "rgb(var(--ink) / <alpha-value>)",
        inkdim: "rgb(var(--inkdim) / <alpha-value>)",
        tally: "rgb(var(--tally) / <alpha-value>)",
        amber: "rgb(var(--amber) / <alpha-value>)",
        stage: "rgb(var(--stage) / <alpha-value>)",
        stageink: "rgb(var(--stageink) / <alpha-value>)",
      },
    },
  },
  plugins: [],
};
export default config;
