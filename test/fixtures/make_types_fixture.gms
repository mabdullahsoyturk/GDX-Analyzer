* Generates types.gdx: every variable type, equation types and set types (subtypes, default field values).
Set i / i1*i2 /;
Singleton Set s / i1 /;
Set t(i) 'subset' / i1 /;
Free Variable vfree(i); Positive Variable vpos(i); Negative Variable vneg(i);
Binary Variable vbin(i); Integer Variable vint(i);
SOS1 Variable vsos1(i); SOS2 Variable vsos2(i);
SemiCont Variable vsc(i); SemiInt Variable vsi(i);
* Assigning levels creates records with the default bounds of each type.
vfree.l(i) = 1; vpos.l(i) = 1; vneg.l(i) = -1; vbin.l(i) = 1; vint.l(i) = 2;
vsos1.l(i) = 1; vsos2.l(i) = 1; vsc.l(i) = 1; vsi.l(i) = 1;
Equation eE(i), eL(i), eG(i), eN(i);
eE(i).. vfree(i) =e= 1;
eL(i).. vfree(i) =l= 1;
eG(i).. vfree(i) =g= 1;
eN(i).. vfree(i) =n= 1;
eE.l(i) = 1; eL.l(i) = 1; eG.l(i) = 1; eN.l(i) = 1;
