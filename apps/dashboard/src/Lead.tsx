// The lead chat is the daemon's own page (it holds the machine token and the permission prompts); this screen frames it.
export function Lead() {
  return (
    <div className="lead-frame">
      <iframe title="Lead" src="/lead" />
    </div>
  );
}
