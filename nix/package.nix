{ pkgs, src }:

let
  bunDeps = import ./bun-deps.nix { inherit pkgs; };
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "skillful";
  version = "0.1.0";
  inherit src;
  nativeBuildInputs = [ pkgs.bun ];
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    NODE_PATH=${bunDeps} bun build --compile cli/main.ts --outfile skillful
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 skillful "$out/bin/skillful"
    runHook postInstall
  '';
  meta = {
    mainProgram = "skillful";
    description = "Author agent skills once, render them per harness";
  };
}
