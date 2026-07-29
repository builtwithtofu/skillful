{ pkgs }:

let
  commanderArchive = pkgs.fetchurl {
    url = "https://registry.npmjs.org/commander/-/commander-14.0.3.tgz";
    hash = "sha256-WElwPFAODzJOsBNA2L2h+exI/De7e+lxLrDdUqrZL2w=";
  };
in
pkgs.runCommandLocal "skillful-bun-node-modules" {
  nativeBuildInputs = [ pkgs.gnutar pkgs.gzip ];
} ''
  mkdir -p "$out/commander"
  tar -xzf ${commanderArchive} --strip-components=1 -C "$out/commander"
''
