############################################################################
#
# Hydra release jobset.
#
# The purpose of this file is to select jobs defined in default.nix and map
# them to all supported build platforms.
#
############################################################################
{
  bcc-rosetta ? { rev = null; }
}:

let
  sources = import ./nix/sources.nix;
  pkgs = import ./nix/pkgs.nix {};

in

pkgs.lib.fix (self: {
  inherit ( import ./. {} ) bcc-rosetta-server;
  build-version = pkgs.writeText "version.json" (builtins.toJSON { inherit (bcc-rosetta) rev; });
  required = pkgs.releaseTools.aggregate {
    name = "required";
    constituents = with self; [
      build-version
      bcc-rosetta-server
    ];
  };
})
