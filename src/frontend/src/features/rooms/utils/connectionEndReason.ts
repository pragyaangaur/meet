/**
 * Why a room ended when no more specific reason applies, passed to the
 * feedback page to pick its heading.
 */
export enum ConnectionEndReason {
  // The room had connected, then the connection was lost for good
  Lost = 'connectionLost',
  // The room never connected
  Failed = 'connectionFailed',
}
