; 安装默认目录使用中文名（用户仍可在安装向导中更改位置）
!macro customInit
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\小说设定管理器"
!macroend

; 卸载时询问是否保留「小说库」数据
!macro customUnInstall
  MessageBox MB_YESNO|MB_ICONQUESTION "是否保留「小说库」数据？$\r$\n选择「是」= 保留小说库数据；选择「否」= 连同数据一起彻底删除" IDYES keepData
  RMDir /r "$INSTDIR"
  Goto uninstallDone
  keepData:
  uninstallDone:
!macroend