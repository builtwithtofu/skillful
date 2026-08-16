{ pkgs, lockfile ? ../bun.lock }:

let
  lib = pkgs.lib;
  stripTrailingCommas = text:
    let
      chars = lib.stringToCharacters text;
      len = builtins.length chars;
      nextSignificant = index:
        if index >= len then null
        else
          let ch = builtins.elemAt chars index;
          in if ch == " " || ch == "\n" || ch == "\t" || ch == "\r" then nextSignificant (index + 1) else ch;
      walked = builtins.foldl' (acc: index:
        let
          ch = builtins.elemAt chars index;
          inString =
            if acc.escape then acc.inString
            else if ch == "\"" then !acc.inString
            else acc.inString;
          escape = acc.inString && !acc.escape && ch == "\\";
          skipComma = !acc.inString && ch == "," && (let next = nextSignificant (index + 1); in next == "}" || next == "]");
        in {
          inherit inString escape;
          out = if skipComma then acc.out else acc.out + ch;
        }) { out = ""; inString = false; escape = false; } (lib.range 0 (len - 1));
    in walked.out;
  lock = builtins.fromJSON (stripTrailingCommas (builtins.readFile lockfile));
  production = lock.workspaces."".dependencies or { };
  packages = lock.packages or { };
  packageTarball = name: versioned:
    let
      version = builtins.elemAt (builtins.match ".+@([^@]+)$" versioned) 0;
      unscoped = let matched = builtins.match "@[^/]+/(.+)" name; in if matched == null then name else builtins.elemAt matched 0;
    in "${unscoped}-${version}.tgz";
  fetchNpmPackage = name: _spec:
    let
      entry = packages.${name} or (throw "bun.lock is missing production package ${name}");
      versioned = builtins.elemAt entry 0;
      integrity = builtins.elemAt entry 3;
    in
    pkgs.fetchurl {
      url = "https://registry.npmjs.org/${name}/-/${packageTarball name versioned}";
      hash = integrity;
    };
in
pkgs.runCommand "skillful-bun-node-modules" {
  nativeBuildInputs = [ pkgs.gnutar pkgs.gzip ];
} ''
  mkdir -p "$out"
  ${lib.concatStringsSep "\n" (lib.mapAttrsToList (name: spec: ''
    mkdir -p "$out/${name}"
    tar -xzf ${fetchNpmPackage name spec} --strip-components=1 -C "$out/${name}"
  '') production)}
''
