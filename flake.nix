{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { self, nixpkgs }: 
  let 
    mkDevShell = system:
    let
      pkgs = nixpkgs.legacyPackages.${system};
    in
    pkgs.mkShell {
      buildInputs = with pkgs; [
        # tauri stuff: https://github.com/tauri-apps/tauri/issues/6612
        cargo
        darwin.apple_sdk.frameworks.AppKit
        darwin.apple_sdk.frameworks.WebKit
        libiconv
        rustc
        rustfmt

        # node for the rest
        nodejs_20
      ];
    };
  in
  {
    devShells.aarch64-darwin.default = mkDevShell "aarch64-darwin";
    devShells.x86_64-darwin.default = mkDevShell "x86_64-darwin";
  };
}
