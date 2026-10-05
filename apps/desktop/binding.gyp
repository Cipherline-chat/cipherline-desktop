{
  "targets": [
    {
      "target_name": "audio_capture",
      "sources": [ "src-native/audio_capture.cc" ],
      "conditions": [
        [
          "OS=='win'",
          {
            "libraries": [
              "-lole32.lib",
              "-luuid.lib",
              "-lmmdevapi.lib",
              "-ldelayimp.lib"
            ],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 1
              },
              "VCLinkerTool": {
                "DelayLoadDLLs": ["mmdevapi.dll", "audioses.dll"]
              }
            }
          }
        ],
        [
          "OS!='win'",
          {
            "cflags_cc": [ "-std=c++17" ]
          }
        ]
      ]
    }
  ]
}
