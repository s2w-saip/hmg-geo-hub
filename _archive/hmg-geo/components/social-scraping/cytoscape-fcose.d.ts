// cytoscape-fcose ships no types. It registers as a cytoscape extension, so
// the default export matches cytoscape's `Ext` (cy => void) registration shape.
declare module "cytoscape-fcose" {
  import type { Ext } from "cytoscape";
  const fcose: Ext;
  export default fcose;
}
