module.exports = {
  plugins: [
    require('tailwindcss'),
    // After Tailwind (covers motion-reduce:/motion-safe:), before autoprefixer.
    // Lets every prefers-reduced-motion block also follow Settings → Accessibility.
    require('./postcss-reduced-motion.cjs')(),
    require('autoprefixer'),
  ],
}
