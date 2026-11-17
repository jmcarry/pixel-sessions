// Clawd Icons has nothing to run: this folder holds the 39 mascots, and the
// sidebar and tab mods show them (see RECIPE.md). This file only makes the
// folder a valid mod. With "place": "none" and no layout block, it never starts.
import { View, div } from "gpui-kit";

export default class ClawdIcons extends View {
  render() {
    return div();
  }
}
