===============================================================================
  StarStereo 93                                  STARSTER.EXE  Version 3.0
  The Professional DOS Engine
===============================================================================

  Thank you for choosing StarStereo. This disk holds the Professional DOS
  Engine (STARSTER.EXE) that ships with StarStereo 93 for Windows: StarStereo
  for big field seasons, for the plotter room, and for the machine in the
  core shed that never got Windows.

  To read this file a screen at a time:  MORE README.TXT

  SYSTEM REQUIREMENTS

    386SX or better
    4 MB RAM
    VGA
    Math coprocessor NOT required

  That last line is not a compromise. StarStereo does all of its arithmetic
  in integers -- CORDIC for the angles, fixed point for the rest -- so it
  runs at full speed on a 386SX without an 80387, and every machine draws
  the same picture to the last pixel.

  WHAT IT DOES

    - Equal-area (Schmidt) and equal-angle (Wulff) nets, lower hemisphere
    - Planes and lines together: poles, lines, great circles
    - Kamb contours (3 sigma cone, 2-8 sigma) and 1% counting
    - The orientation tensor: eigenvalues, axes, Woodcock's K; girdles
      are recognised, and their axis (beta) reported
    - A data table to edit in, or to type a new data set into
    - A cursor to read the net with -- and to add what it points at
    - Whole field seasons: 32-bit flat memory (DOS extender), no 64K limits
    - Mode X preview (320x240, 256 colours, square pixels -- the net is a
      circle, not an egg) and mode 12h plots (640x480, 16 colours)
    - PCX output, for your paint program, your word processor, your printer
    - Batch mode for the night shift

  GETTING STARTED

    C:\> STARSTER FIELD94.DAT

  F10 opens the menus (or Alt and a menu's red letter); every command is in
  them, with its key beside it. F1 lists the keys. The ones to know:

    F2   open a file (pick it from a list, walk the folders and drives)
    Tab  the table: Arrows move, Enter edits a cell, Ins adds a row,
         Del deletes it, Space turns a row from plane to line
    Arrows on the net: the cursor. Space switches it between moving over
         the net and turning an attitude a degree at a time (Shift: ten);
         Enter adds what it points at to the table
    F3   Schmidt or Wulff      F6  contours: Kamb, 1%, off
    F8   save the picture      F9  the preview, or the plot
    Ctrl-S  save the data      Alt-X  exit

  StarStereo remembers the screen, the net and the contours in STARSTER.CFG.

  YOUR DATA

  A plain text file, one measurement a line:

    045 30          a plane: dip direction, dip
    045/30          the same
    # a comment     ignored

  Planes are assumed; /L reads lines (trend, plunge). A file with a header
  line is read by its column names: "dip direction" and "dip", "trend" and
  "plunge", "strike" (right-hand rule) and "dip"; "type" (plane or line) and
  "label" too. Commas, semicolons and tabs all work. StarStereo saves as
  type,dip_dir_or_trend,dip_or_plunge,label -- the columns of wuffle's
  field log, so the file opens there as it is.

  COMMAND LINE

    STARSTER [file] [/X | /12] [/P | /L] [/WULFF] [/KAMB | /PCT]
             [/PCX out.pcx] [/BATCH] [/NOLOGO]

    /X        start in the 320x240 preview
    /12       start in the 640x480 plot (the default)
    /P /L     the file holds planes / lines
    /WULFF    the equal-angle net
    /KAMB     Kamb contours on           /PCT  1% counting contours on
    /PCX f    draw, write the picture to f, print the report, and stop
    /BATCH    print the report and stop
    /NOLOGO   no title box at the start

    STARSTER FIELD94.DAT /KAMB /PCX FIELD94.PCX > FIELD94.TXT

  THE SAMPLE

  FIELD94.DAT is the 200 joint measurements of Tocher, F. E. (1979), The
  computer contouring of fabric diagrams, Computers & Geosciences 5, 73-126.

-------------------------------------------------------------------------------
  A NOTE FROM 2026

  StarStereo never existed. It is design fiction: the imagined 1993
  ancestor of wuffle (gentropic.org/wuffle), written in 2026 as if it had
  shipped then -- C89, Open Watcom, DOS/32A, no floating point -- and run
  here in DOSBox. Its numbers are checked against wuffle's own, and agree.
  The real line it nods to is OpenStereo (Grohmann & Campanha, 2009/10) and
  its 2016 rewrite. Free software, MIT licence. Geoscientific Chaos Union.
-------------------------------------------------------------------------------
