function Notice({ text }: { text: string }) {
  return <div data-testid="notice">{text}</div>;
}

export default { notice: Notice };
