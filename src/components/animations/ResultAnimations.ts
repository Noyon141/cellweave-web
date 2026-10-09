export const chartFadeInVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.25 } },
};

export const progressPulseVariants = {
  initial: { scale: 1 },
  pulse: {
    scale: [1, 1.02, 1],
    transition: { duration: 1.5, repeat: Infinity, ease: "easeInOut" },
  },
};
