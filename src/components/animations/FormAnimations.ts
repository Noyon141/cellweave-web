export const formFieldVariants = {
  hidden: { opacity: 0, y: 4 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.15 } },
};

export const formErrorVariants = {
  hidden: { opacity: 0, height: 0 },
  visible: { opacity: 1, height: "auto", transition: { duration: 0.15 } },
  exit: { opacity: 0, height: 0, transition: { duration: 0.1 } },
};
