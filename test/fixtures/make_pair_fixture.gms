* Generates pair1.gdx and pair2.gdx, two files that differ in most ways gdxdiff distinguishes (for gdxDiff.ts):
*   gams make_pair_fixture.gms --v=1 && gams make_pair_fixture.gms --v=2
$onUndf
$ifThen %v% == 2
Set caseS 'labels spelled differently' / 'I1', 'X' /;
$endIf
Set i / i1*i3 /, j / a, b, c /, t / t1*t2 /, k / k1*k5 /;
Set s(i) 'set texts' / i1 'first', i2 'second', i3 /;
$ifThen %v% == 2
Set s2(i) 'set texts' / i1 'first', i2 'changed', i3 'new text' /;
$else
Set s2(i) 'set texts' / i1 'first', i2 'second' /;
$endIf
$ifThen %v% == 1
Set caseS 'labels spelled differently' / 'i1', 'x' /;
$endIf
Alias (i, ii);
Acronym high, low;
Parameter
   pi_ / 3.14159 /
   sp(*) 'special values'
   lev(i) 'acronyms'
   w(k) 'values'
   only1 'only in file 1' / 1 /
   d20(i,i,i,i,i,i,i,i,i,i,i,i,i,i,i,i,i,i,i,i);
sp('eps') = eps; sp('na') = na; sp('pinf') = +inf; sp('undf') = undf; sp('one') = 1;
lev('i1') = high; lev('i2') = low;
w(k) = ord(k) / 3;
d20('i1','i1','i1','i1','i1','i1','i1','i1','i1','i1','i1','i1','i1','i1','i1','i1','i1','i1','i1','i1') = 1;
$ifThen %v% == 2
pi_ = 3.1416;
sp('eps') = 0; sp('na') = 5; sp('extra') = 9; sp('one') = 1.0000001;
lev('i1') = low; lev('i3') = high;
w('k5') = 0; w('k2') = w('k2') + 1e-9; w('k3') = w('k3') * 1.001;
d20('i1','i1','i1','i1','i1','i1','i1','i1','i1','i1','i1','i1','i1','i1','i1','i1','i1','i1','i1','i1') = 2;
Parameter newp 'only in file 2' / 2 /;
Set tchange / a /;
Parameter dchange(i,j); dchange('i1','a') = 1;
Parameter domchg(t); domchg('t1') = 1;
$else
Parameter tchange / a 1 /;
Parameter dchange(i); dchange('i1') = 1;
Parameter domchg(i); domchg('i1') = 1;
$endIf
Positive Variable x(i,j), xd(i);
Free Variable z;
Equation eL(i), eE(i), eG(i);
eL(i).. x(i,'a') =l= 0;
eE(i).. x(i,'b') =e= 0;
eG(i).. x(i,'c') =g= 0;
x.l(i,j) = ord(i) + ord(j); x.m('i1','a') = 0.5; z.l = 10;
eL.l(i) = 1; eE.l(i) = 1; eG.l(i) = 1;
$ifThen %v% == 2
x.l('i2','b') = 4.5; x.up('i3','c') = 100; x.m('i1','a') = eps; z.l = 10.5;
x.l('i3','a') = 0; x.m('i3','a') = 0;
eL.m('i2') = -1; eE.l('i3') = 2;
* Records with the default values of their type, in file 2 only.
xd.lo(i) = 0;
eL.l('i3') = 0; eE.l('i3') = 0;
$endIf
execute_unload 'pair%v%.gdx', caseS, i, j, t, k, s, s2, ii, pi_, sp, lev, w, d20, tchange, dchange, domchg, x, xd, z, eL, eE, eG
$if %v% == 1 , only1
$if %v% == 2 , newp
;
