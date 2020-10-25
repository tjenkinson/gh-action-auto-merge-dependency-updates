export enum Result {
  UnknownEvent,
  ActorNotAllowed,
  // TODO better name?
  InvalidFiles,
  UnexpectedChanges,
  UnexpectedPropertyChange,
  VersionChangeNotAllowed,
  PRNotOpen,
  PRHeadChanged,
  Success,
}
