* Generates native.gdx (compressed): what the native GDX reader (src/gdxReader.ts) must read like gdxdump.
*   gams make_native_fixture.gms
* formats/transport1_*.gdx are transport1.gdx in the other file formats, made with gdxcopy:
*   cd formats && cp ../transport1.gdx . && gdxcopy -V5 transport1.gdx v5 (likewise -V6U, -V6C, -V7C)
$setEnv GDXCOMPRESS 1
$onUndf
Set i 'plants' / i1*i3 /
    j 'markets' / 'new york' 'NY', "it's" "single quote", 'a,b' 'comma', 'süß' 'unicode' /
    k 'many labels: word-sized keys' / k1*k300 /
    big 'labels far apart: integer-sized keys' / b1*b70000 /
    s(i) 'a subset with texts' / i1 'first', i2 'first', i3 /
    t 'without texts' / t1*t2 /;
Singleton Set one(i) / i2 /;
Alias (i, ii), (*, u);
Acronym high, low;

Parameter
   zero 'a scalar without a stored record'
   pi_ 'a scalar' / 3.14159 /
   specials(*) 'special values' / eps eps, na na, pinf +inf, minf -inf, undf undf, tiny 1e-300, neg -2.5, half 0.5, two 2, mone -1, one 1 /
   level(i) 'acronyms' / i1 high, i2 low, i3 7 /
   digits(*) 'how gdxdump writes numbers: ties at the 16th digit, near 1e15 and 1e-4, exponents'
          / t1 12345678901234.5, t2 1234567890123465, t3 1234567890123455, t4 999999999999999.9, t5 9.999999999999999e-5,
            t6 0.0001, t7 1.5e30, t8 1.5e-200, t9 153.675, t10 1e15, t11 0.1, t12 0.3333333333333333, t13 -7.25e-12, t14 123456.789 /
   dup(i,i) 'a repeated domain'
   dup3(i,j,i) 'a domain repeated after another one'
   wide(k) 'word-sized keys'
   sparse(big) 'integer-sized keys'
   empty(i,j) 'no records'
   d20(i,i,i,i,i,i,i,i,i,i,i,i,i,i,i,i,i,i,i,i) 'twenty dimensions';
dup(i,ii)$(ord(i) <= ord(ii)) = ord(i) * 10 + ord(ii);
dup3(i,j,ii)$(ord(i) = ord(ii)) = ord(j);
wide(k) = ord(k) / 7;
sparse('b1') = 1;
sparse('b70000') = 70000;
sparse('b33333') = -1;
d20('i1','i2','i3','i1','i2','i3','i1','i2','i3','i1','i2','i3','i1','i2','i3','i1','i2','i3','i1','i2') = 20;
d20('i3','i3','i3','i3','i3','i3','i3','i3','i3','i3','i3','i3','i3','i3','i3','i3','i3','i3','i3','i3') = 3;

Free Variable vfree(i); Positive Variable vpos(i); Negative Variable vneg(i);
Binary Variable vbin(i); Integer Variable vint(i);
SOS1 Variable vsos1(i); SOS2 Variable vsos2(i);
SemiCont Variable vsc(i); SemiInt Variable vsi(i);
Free Variable vscalar 'a scalar variable without a stored record';
Positive Variable vpscalar 'a positive scalar variable with a record';
vfree.l(i) = ord(i); vpos.l('i2') = 2; vneg.l('i1') = -1; vbin.l('i3') = 1;
vint.l(i) = 3; vint.prior('i1') = 5; vsc.l('i1') = 1.5; vsc.up('i1') = 10; vsi.l('i2') = 2;
vsos1.l('i1') = 1; vsos2.m('i2') = eps; vpscalar.l = 4; vfree.m('i1') = na; vpos.up('i3') = undf;
Equation eE(i), eL(i), eG(i), eN(i), escalarL 'an =L= scalar without a stored record', escalarG 'an =G= scalar without a stored record';
eE(i).. vfree(i) =e= 1;
eL(i).. vfree(i) =l= 1;
eG(i).. vfree(i) =g= 1;
eN(i).. vfree(i) =n= 1;
escalarL.. sum(i, vfree(i)) =l= 3;
escalarG.. sum(i, vfree(i)) =g= 3;
eE.l(i) = 1; eL.m('i2') = -0.5; eG.l('i3') = 2; eN.scale('i1') = 2;

* Written without i and j: their domains are relaxed (names only).
execute_unload 'native.gdx', k, big, s, t, one, ii, u, zero, pi_, specials, level, digits, dup, dup3, wide, sparse, empty, d20,
   vfree, vpos, vneg, vbin, vint, vsos1, vsos2, vsc, vsi, vscalar, vpscalar, eE, eL, eG, eN, escalarL, escalarG;
* The acronyms of level are written with it.
